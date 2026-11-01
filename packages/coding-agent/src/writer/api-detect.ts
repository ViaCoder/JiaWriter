/**
 * WriterAgent API type detection.
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
		return { api: probe.api, status: response.status, verdict: classifyProbe(response.status, body) };
	} catch {
		// DNS, TLS, refused connection or timeout.
		return { api: probe.api, status: 0, verdict: "next" };
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

/** Cache key: sha256 of URL and model name (the API key is never part of it). */
export function detectCacheKey(root: string, model: string): string {
	// Hash the two values separated by a newline.
	return createHash("sha256").update(`${root}\n${model}`).digest("hex");
}

/** On-disk cache format. */
interface DetectCacheFile {
	// Format version.
	version: 1;
	// Detected API per cache key.
	entries: Record<string, { api: WriterApi; detectedAt: string }>;
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

/** Look up a cached API for a key. */
export function loadDetectCache(path: string, key: string): WriterApi | undefined {
	// Entry for this URL and model.
	const entry = readCacheFile(path).entries[key];
	// Only accept known API names.
	return entry && (WRITER_APIS as readonly string[]).includes(entry.api) ? entry.api : undefined;
}

/** Store a detected API for a key (atomic write). */
export function saveDetectCache(path: string, key: string, api: WriterApi, now: Date = new Date()): void {
	// Start from the existing entries.
	const cache = readCacheFile(path);
	// Add or replace this entry.
	cache.entries[key] = { api, detectedAt: now.toISOString() };
	// Make sure the directory exists.
	mkdirSync(dirname(path), { recursive: true });
	// Write to a temp file first.
	const tmp = `${path}.tmp-${process.pid}`;
	// Pretty JSON with a final newline.
	writeFileSync(tmp, `${JSON.stringify(cache, null, "\t")}\n`);
	// Replace atomically.
	renameSync(tmp, path);
}
