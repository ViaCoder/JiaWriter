/**
 * JiaWriter API type detection.
 * One deliberately invalid request per API (an output limit of 0 and no messages):
 * the server rejects it while validating parameters, generates nothing and bills no tokens.
 */

// Cache key hashing.
import { createHash } from "node:crypto";
// Cache file access.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Path of the cache file's directory.
import { dirname } from "node:path";
// API names and their order.
import { WRITER_APIS, type WriterApi } from "./env-config.ts";

/** Anthropic API version header value sent with the probe. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Timeout for one probe request. */
export const PROBE_TIMEOUT_MS = 15_000;
/** At most this many bytes of an error body are read (only to classify it). */
const PROBE_BODY_LIMIT = 4_096;

/** Path appended to the root URL for each API. */
const PROBE_PATHS: Record<WriterApi, string> = {
	// Anthropic Messages.
	"anthropic-messages": "/v1/messages",
	// OpenAI Responses.
	"openai-responses": "/v1/responses",
	// OpenAI Chat Completions.
	"openai-completions": "/v1/chat/completions",
};

/** A ready-to-send probe. */
export interface Probe {
	// API being tested.
	api: WriterApi;
	// Full endpoint URL.
	url: string;
	// fetch() options.
	init: RequestInit;
}

/** What a probe response means. */
export type ProbeVerdict = "match" | "next" | "auth";

/** Request bodies that fail validation on every API: an output limit of 0 and no input. */
const PROBE_BODIES: Record<WriterApi, (model: string) => Record<string, unknown>> = {
	// Anthropic requires max_tokens >= 1 and at least one message.
	"anthropic-messages": (model) => ({ model, max_tokens: 0, messages: [] }),
	// Responses requires max_output_tokens >= 16.
	"openai-responses": (model) => ({ model, input: [], max_output_tokens: 0 }),
	// Chat Completions requires at least one message.
	"openai-completions": (model) => ({ model, messages: [], max_tokens: 0 }),
};

/** Build the probe request for one API. */
export function buildProbe(root: string, api: WriterApi, key: string, model: string): Probe {
	// JSON body that the server rejects during validation, before any generation.
	const body = JSON.stringify(PROBE_BODIES[api](model));
	// Anthropic authenticates with x-api-key and needs a version header.
	const headers: Record<string, string> =
		api === "anthropic-messages"
			? { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }
			: { "content-type": "application/json", authorization: `Bearer ${key}` };
	// Assemble the probe.
	return { api, url: `${root}${PROBE_PATHS[api]}`, init: { method: "POST", headers, body } };
}

/** Body phrases that mean "this route or model does not exist here". */
const NOT_HERE =
	/(model[^.]{0,40}(not found|does not exist|not exist|unknown|unsupported|invalid model))|model_not_found|unknown (url|route|endpoint|path)|no route|not found|unrecognized request url|invalid url/i;

/** Classify a probe response from its status code and (short) body. */
export function classifyProbe(status: number, body: string): ProbeVerdict {
	// Wrong or unauthorized key: stop probing.
	if (status === 401 || status === 403) return "auth";
	// Missing route or method: try the next API.
	if (status === 404 || status === 405) return "next";
	// The server accepted the request: the route and the model work here.
	if (status >= 200 && status < 300) return "match";
	// A validation error proves the route exists and accepts this model...
	if (status === 400 || status === 422) {
		// ...unless the error says the model or the route is unknown.
		return NOT_HERE.test(body) ? "next" : "match";
	}
	// Anything else (rate limit, server error) proves nothing.
	return "next";
}

/** Outcome of one probe. */
export interface ProbeOutcome {
	// API tested.
	api: WriterApi;
	// HTTP status, or 0 when the request failed before a response.
	status: number;
	// Meaning of the response.
	verdict: ProbeVerdict;
	// First bytes of the response body, used only to compare probes (never logged or shown).
	body: string;
}

/** Send one probe and classify the answer; network failures count as "next". */
export async function probeEndpoint(
	fetchFn: typeof fetch,
	probe: Probe,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
	try {
		// One request with a hard timeout.
		const response = await fetchFn(probe.url, { ...probe.init, signal: AbortSignal.timeout(timeoutMs) });
		// Read a short part of the body for classification only (never logged).
		const body = (await response.text()).slice(0, PROBE_BODY_LIMIT);
		// Classify.
		return { api: probe.api, status: response.status, verdict: classifyProbe(response.status, body), body };
	} catch {
		// DNS, TLS, refused connection or timeout.
		return { api: probe.api, status: 0, verdict: "next", body: "" };
	}
}

/** Result of a detection run. */
export type DetectResult =
	// Found the API.
	| { ok: true; api: WriterApi; outcomes: ProbeOutcome[] }
	// Stopped on an auth error, or nothing matched.
	| { ok: false; reason: "auth" | "none"; outcomes: ProbeOutcome[] };

/** Probe the APIs in order; stop at the first match or at an auth error. */
export async function detectApi(
	root: string,
	key: string,
	model: string,
	fetchFn: typeof fetch,
): Promise<DetectResult> {
	// Every probe that was sent.
	const outcomes: ProbeOutcome[] = [];
	// Anthropic first, then Responses, then Chat Completions.
	for (const api of WRITER_APIS) {
		// Exactly one request per API.
		const outcome = await probeEndpoint(fetchFn, buildProbe(root, api, key, model));
		// Keep it for the report.
		outcomes.push(outcome);
		// Found it.
		if (outcome.verdict === "match") return { ok: true, api, outcomes };
		// Bad key: further probes would fail the same way.
		if (outcome.verdict === "auth") return { ok: false, reason: "auth", outcomes };
	}
	// Nothing matched.
	return { ok: false, reason: "none", outcomes };
}

/** How the endpoint accepts reasoning parameters. */
export type ReasoningMode = "effort" | "budget" | "none";

/** Reasoning support found for one endpoint and model. */
export interface ReasoningSupport {
	// "effort": a level name per request; "budget": Anthropic thinking budgets; "none": no reasoning.
	mode: ReasoningMode;
	// Supported levels among low, medium, high, xhigh, max.
	levels: string[];
}

/** Levels tested for support, from lowest to highest. */
export const REASONING_PROBE_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Words that appear when a server rejects a reasoning parameter. */
const REASONING_WORDS = /reasoning|effort|thinking|budget|output_config/i;

/** Build a probe that carries one reasoning setting on top of the invalid base body. */
export function buildReasoningProbe(
	root: string,
	api: WriterApi,
	key: string,
	model: string,
	level: string,
	mode: "effort" | "budget" = "effort",
): Probe {
	// Start from the ordinary detection probe (output limit 0, no messages).
	const base = buildProbe(root, api, key, model);
	// Its JSON body as an object.
	const body = JSON.parse(String(base.init.body)) as Record<string, unknown>;
	// Anthropic: adaptive thinking with an effort level, or a fixed thinking budget.
	if (api === "anthropic-messages") {
		// Budget-based thinking (older models).
		if (mode === "budget") body.thinking = { type: "enabled", budget_tokens: 1024 };
		// Adaptive thinking with an effort level (current models).
		else Object.assign(body, { thinking: { type: "adaptive" }, output_config: { effort: level } });
	} else if (api === "openai-responses") {
		// Responses: reasoning.effort.
		body.reasoning = { effort: level };
	} else {
		// Chat Completions: reasoning_effort.
		body.reasoning_effort = level;
	}
	// Same URL and headers, new body.
	return { ...base, init: { ...base.init, body: JSON.stringify(body) } };
}

/** Compare a reasoning probe with the plain probe: "unsupported" when the reasoning parameter caused a new error. */
export function classifyReasoningProbe(
	baseline: { status: number; body: string },
	probe: { status: number; body: string },
): "supported" | "unsupported" | "auth" {
	// Key problems end everything.
	if (probe.status === 401 || probe.status === 403) return "auth";
	// Accepted outright.
	if (probe.status >= 200 && probe.status < 300) return "supported";
	// No response at all: treat the level as unavailable.
	if (probe.status === 0) return "unsupported";
	// A different status than the plain probe means the parameter changed the outcome.
	if (probe.status !== baseline.status) return "unsupported";
	// The error now names a reasoning parameter that the plain error did not.
	if (REASONING_WORDS.test(probe.body) && !REASONING_WORDS.test(baseline.body)) return "unsupported";
	// Same rejection as without reasoning: the parameter itself passed validation.
	return "supported";
}

/** Probe which reasoning levels an endpoint accepts (zero-token requests, at most six). */
export async function detectReasoning(
	root: string,
	api: WriterApi,
	key: string,
	model: string,
	fetchFn: typeof fetch,
	baseline: { status: number; body: string },
): Promise<ReasoningSupport | "auth"> {
	// Supported levels in effort mode.
	const levels: string[] = [];
	// One probe per level.
	for (const level of REASONING_PROBE_LEVELS) {
		// Send it.
		const outcome = await probeEndpoint(fetchFn, buildReasoningProbe(root, api, key, model, level));
		// Classify against the plain probe.
		const verdict = classifyReasoningProbe(baseline, outcome);
		// Stop on a key problem.
		if (verdict === "auth") return "auth";
		// Keep the supported ones.
		if (verdict === "supported") levels.push(level);
	}
	// Any level works: effort mode.
	if (levels.length > 0) return { mode: "effort", levels };
	// Only Anthropic has a second, budget-based form.
	if (api !== "anthropic-messages") return { mode: "none", levels: [] };
	// One budget probe.
	const outcome = await probeEndpoint(fetchFn, buildReasoningProbe(root, api, key, model, "high", "budget"));
	// Classify.
	const verdict = classifyReasoningProbe(baseline, outcome);
	// Key problem.
	if (verdict === "auth") return "auth";
	// Budgets cover low, medium and high; xhigh and max fall back to high.
	return verdict === "supported"
		? { mode: "budget", levels: ["low", "medium", "high"] }
		: { mode: "none", levels: [] };
}

/** Cache key: sha256 of URL and model name (the API key is never part of it). */
export function detectCacheKey(root: string, model: string): string {
	// Hash the two values separated by a newline.
	return createHash("sha256").update(`${root}\n${model}`).digest("hex");
}

/** One cached detection. */
export interface DetectCacheEntry {
	// Detected API.
	api: WriterApi;
	// When it was detected.
	detectedAt: string;
	// Reasoning support, once it has been probed.
	reasoning?: ReasoningSupport;
}

/** On-disk cache format. */
interface DetectCacheFile {
	// Format version.
	version: 1;
	// Detection per cache key.
	entries: Record<string, DetectCacheEntry>;
}

/** Read the whole cache file; a missing or broken file is an empty cache. */
function readCacheFile(path: string): DetectCacheFile {
	// No file yet.
	if (!existsSync(path)) return { version: 1, entries: {} };
	try {
		// Parse the JSON.
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<DetectCacheFile>;
		// Accept only the known version with an entries object.
		if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object")
			return parsed as DetectCacheFile;
	} catch {
		// A damaged file is ignored and rewritten on the next save.
	}
	// Fall back to an empty cache.
	return { version: 1, entries: {} };
}

/** Write the cache file atomically. */
function writeCacheFile(path: string, cache: DetectCacheFile): void {
	// Make sure the directory exists.
	mkdirSync(dirname(path), { recursive: true });
	// Write to a temp file first.
	const tmp = `${path}.tmp-${process.pid}`;
	// Pretty JSON with a final newline.
	writeFileSync(tmp, `${JSON.stringify(cache, null, "\t")}\n`);
	// Replace atomically.
	renameSync(tmp, path);
}

/** Look up a cached detection for a key. */
export function loadDetectCache(path: string, key: string): DetectCacheEntry | undefined {
	// Entry for this URL and model.
	const entry = readCacheFile(path).entries[key];
	// Only accept known API names.
	return entry && (WRITER_APIS as readonly string[]).includes(entry.api) ? entry : undefined;
}

/** Store a detection for a key (atomic write). */
export function saveDetectCache(
	path: string,
	key: string,
	api: WriterApi,
	now: Date = new Date(),
	reasoning?: ReasoningSupport,
): void {
	// Start from the existing entries.
	const cache = readCacheFile(path);
	// Add or replace this entry; reasoning only when known.
	cache.entries[key] = reasoning
		? { api, detectedAt: now.toISOString(), reasoning }
		: { api, detectedAt: now.toISOString() };
	// Persist.
	writeCacheFile(path, cache);
}

/** Remove one reasoning level after the server rejected it; returns the updated support or undefined. */
export function markReasoningUnsupported(path: string, key: string, level: string): ReasoningSupport | undefined {
	// Current cache.
	const cache = readCacheFile(path);
	// Entry for this endpoint.
	const entry = cache.entries[key];
	// Nothing known: nothing to update.
	if (!entry?.reasoning) return undefined;
	// Drop the rejected level.
	const levels = entry.reasoning.levels.filter((l) => l !== level);
	// No level left means no reasoning.
	entry.reasoning = levels.length > 0 ? { mode: entry.reasoning.mode, levels } : { mode: "none", levels: [] };
	// Persist.
	writeCacheFile(path, cache);
	// Hand back the new support.
	return entry.reasoning;
}
