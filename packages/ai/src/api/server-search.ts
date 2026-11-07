/**
 * Search and page reads done by the upstream itself, in a request of their own.
 * "claude" uses the Anthropic server tools on /v1/messages; "codex" uses the OpenAI hosted
 * web_search tool on /v1/responses. The conversation's streams drop citations and the server
 * tool blocks, so this file reads the whole reply through the SDKs instead.
 * Whether the upstream takes a plain or an OAuth-style request is found by sending one,
 * never by looking at the key.
 */

// The Anthropic message types.
import type {
	BetaContentBlock,
	BetaMessageParam,
	BetaTextBlockParam,
	BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
// The OpenAI client.
import OpenAI from "openai";
// The OpenAI response types.
import type { Response, ResponseInput } from "openai/resources/responses/responses";
// Levels a model really offers.
import { clampThinkingLevel } from "../models.ts";
// Shared types.
import type { Api, FetchFunction, Model, ModelThinkingLevel, ProviderHeaders } from "../types.ts";
// The Anthropic client, its OAuth identity and its effort names.
import { claudeCodeVersion, mapThinkingLevelToEffort, PiAnthropic } from "./anthropic-messages.ts";
// The address and account of a Codex login.
import { extractAccountId, resolveCodexUrl } from "./openai-codex-responses.ts";
// The record of each request.
import {
	failureEntry,
	hostsOf,
	type ServerLog,
	type ServerLogWrite,
	secretsOf,
	serverLog,
	tracedFetch,
} from "./server-trace.ts";
// Thinking budgets of older models.
import { adjustMaxTokensForThinking } from "./simple-options.ts";

/** Which way of asking the upstream. */
export type ServerWay = "claude" | "codex";

/** How the request is shaped: plain, or the form an OAuth login uses. */
export type ServerStyle = "plain" | "oauth";

/** What one call needs; everything follows the conversation it runs in. */
export interface ServerCall {
	// Way of asking.
	way: ServerWay;
	// Upstream address without /v1.
	baseUrl: string;
	// The conversation's model.
	model: Model<Api>;
	// The key as configured.
	apiKey?: string;
	// Extra request headers.
	headers?: ProviderHeaders;
	// The conversation's thinking level.
	thinking: ModelThinkingLevel;
	// Styles that worked in this session, by way and address.
	styles: Map<string, ServerStyle>;
	// Stops the request.
	signal?: AbortSignal;
	// Takes the record of this call, line by line; lines hold no key.
	log?: ServerLogWrite;
	// Allows Codex's own search endpoint; without it only the hosted tool is used.
	direct?: ServerDirect;
}

/** What the endpoint needs across the calls of a session. */
export interface ServerDirect {
	// The session's id: references like turn0search3 live under it.
	id: string;
	// Addresses that did not take the endpoint this session.
	refused: Set<string>;
}

/** The time window of a search. */
export type ServerFresh = "day" | "week" | "month" | "year";

/** What a page read can ask for besides the page. */
export interface ServerPageOptions {
	// Line to read from, for the rest of a long page.
	lineno?: number;
	// Words to find in the page instead of reading all of it.
	find?: string;
}

/** One source the upstream used. */
export interface ServerSource {
	// Address.
	url: string;
	// Title ("" when none).
	title: string;
	// Text cited from it ("" when none).
	snippet: string;
	// Age or date as the upstream gives it ("" when none).
	date: string;
}

/** What a search returns. */
export interface ServerReport {
	// The upstream's own text.
	text: string;
	// The sources, each address once.
	sources: ServerSource[];
}

/** What a page read returns. */
export interface ServerPage {
	// Address the upstream reports ("" when none).
	url: string;
	// Title ("" when none).
	title: string;
	// Text of the page.
	content: string;
}

/** Why a call gave nothing usable. */
export type ServerErrorCode = "no_search" | "no_open" | "tool_error" | "pdf" | "upstream";

/** A failure the caller can name; the message never holds the key. */
export class ServerSearchError extends Error {
	// Kind of failure.
	code: ServerErrorCode;

	/** Build one. */
	constructor(code: ServerErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** Most searches in one request, the number Claude Code uses. */
const MAX_SEARCHES = 8;
/** Output limit of an inner request: the page or the results come from the tools, not the reply. */
const REPLY_TOKENS = 16_000;
/** Fewest characters of a real page: real replies that gave no page were 137 to 333 (log of 2026-11-06). */
const MIN_PAGE = 500;
/** Longest reply of Codex's own search endpoint, in tokens. */
const MAX_DIRECT_TOKENS = 16000;
/** Days of each time window. */
const FRESH_DAYS: Readonly<Record<ServerFresh, number>> = { day: 1, week: 7, month: 30, year: 365 };
/** Most resumes of a paused turn: a guard against a reply that never ends. */
const MAX_ROUNDS = 5;
/** Statuses that may mean the other request style is wanted. */
const STYLE_STATUSES = new Set([401, 403, 404]);
/** The identity an OAuth login has to declare. */
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Beta flags of an OAuth login. */
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";
/** The search tool of the "claude" way. */
const CLAUDE_SEARCH: BetaToolUnion = { type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES };
/** The fetch tool of the "claude" way: one page, no length limit. */
const CLAUDE_FETCH: BetaToolUnion = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 };
/** Sources are only listed when asked for. */
const CODEX_INCLUDE = "web_search_call.action.sources";
/** Instructions of a search. */
const SEARCH_RULES =
	"Research the user's question on the web until it is answered, in several rounds, and never answer from memory. Start broad, then search again with what you found: new terms, official names, other languages. Open the primary sources and the strongest reports and read them. Check key facts against a second source. When a page is blocked, look for the same document at another official source. Then write a complete, organized report of what the sources say, giving each fact its date and source link, and name every page you could not open and what stayed unknown.";
/** Instructions of a page read on the "claude" way: the text comes from the tool, not the reply. */
const FETCH_RULES = "Fetch the exact page the user names with the fetch tool, then reply with one short sentence.";
/** Instructions of a page read on the "codex" way: the reply is all there is. */
const OPEN_RULES =
	"Open the exact page the user names with the web search tool, and never answer from memory. Report everything it says in full detail, in its own language: every fact, figure, date, name and section, in the page's order. Add no comments. If it cannot be opened, say so and stop.";

/** Status of a failed request, or undefined when it never got one. */
function statusOf(error: unknown): number | undefined {
	// The SDKs put it on the error.
	const status = (error as { status?: unknown } | undefined)?.status;
	// Only a number counts.
	return typeof status === "number" ? status : undefined;
}

/** Text of an error with the key taken out. */
function callLog(call: ServerCall): ServerLog | undefined {
	// Nothing is built when no log is kept.
	if (!call.log) return undefined;
	// The key, the headers and the upstream's name stay out of it.
	return serverLog(call.log, [
		...secretsOf(call.apiKey, call.headers, call.model.headers),
		...hostsOf(call.baseUrl, call.model.baseUrl),
	]);
}

/** The fetch of a call's client: recorded when the call keeps a log, else the SDK's own. */
function clientFetch(call: ServerCall): FetchFunction | undefined {
	// One logger for the client's requests.
	const log = callLog(call);
	return log ? tracedFetch(log) : undefined;
}

/** Run a call between a start and an end in the log. */
async function recorded<T>(
	call: ServerCall,
	what: "search" | "fetch",
	target: string | undefined,
	run: () => Promise<T>,
	result: (out: T) => Record<string, unknown>,
): Promise<T> {
	// Nothing is built when no log is kept.
	const log = callLog(call);
	// For the time it took.
	const started = Date.now();
	log?.({
		kind: "start",
		what,
		target,
		way: call.way,
		api: call.model.api,
		model: call.model.id,
		reasoning: call.model.reasoning,
		thinking: call.thinking,
		// A style found earlier in this session is tried first.
		known: call.styles.get(`${call.way}\n${call.baseUrl}`) ?? "",
	});
	try {
		const out = await run();
		log?.({ kind: "done", ms: Date.now() - started, ...result(out) });
		return out;
	} catch (error) {
		log?.(failureEntry(error, Date.now() - started));
		throw error;
	}
}

/** The message of an error, without the key. */
function cleanMessage(error: unknown, key: string | undefined): string {
	// The plain message.
	const message = error instanceof Error ? error.message : String(error);
	// An upstream may echo what it was sent.
	return key ? message.split(key).join("<redacted>") : message;
}

/** Send with the style known to work, else plain first and the OAuth style once on an auth or path error. */
async function withStyle<T>(call: ServerCall, send: (style: ServerStyle) => Promise<T>): Promise<T> {
	// Styles are kept per way and address.
	const slot = `${call.way}\n${call.baseUrl}`;
	/** One try; the log gets the SDK's own error before it is wrapped below. */
	const attempt = async (style: ServerStyle): Promise<T> => {
		// For the time it took.
		const started = Date.now();
		try {
			return await send(style);
		} catch (error) {
			callLog(call)?.({ ...failureEntry(error, Date.now() - started), kind: "attempt-failed", style });
			throw error;
		}
	};
	// Known from an earlier call.
	const known = call.styles.get(slot);
	if (known) {
		try {
			return await attempt(known);
		} catch (error) {
			// The upstream changed: find out again next time.
			if (STYLE_STATUSES.has(statusOf(error) ?? 0)) call.styles.delete(slot);
			throw rethrown(call, error);
		}
	}
	// The plain request.
	let first: unknown;
	try {
		const out = await attempt("plain");
		call.styles.set(slot, "plain");
		return out;
	} catch (error) {
		// Anything but an auth or path error is the answer.
		if (!STYLE_STATUSES.has(statusOf(error) ?? 0)) throw rethrown(call, error);
		first = error;
	}
	// The same key, the OAuth form, once.
	try {
		const out = await attempt("oauth");
		call.styles.set(slot, "oauth");
		return out;
	} catch (error) {
		// Stopped by the caller, or a named failure: that is the answer.
		if (call.signal?.aborted || error instanceof ServerSearchError) throw rethrown(call, error);
		// Both failures together.
		throw new ServerSearchError(
			"upstream",
			`plain: ${cleanMessage(first, call.apiKey)}; oauth: ${cleanMessage(error, call.apiKey)}`,
		);
	}
}

/** An error ready to leave this file: cancels and named failures as they are, the rest named and cleaned. */
function rethrown(call: ServerCall, error: unknown): unknown {
	// The caller stopped it, or it already has a name.
	if (call.signal?.aborted || error instanceof ServerSearchError) return error;
	// An upstream failure without the key.
	return new ServerSearchError("upstream", cleanMessage(error, call.apiKey));
}

/** Thinking fields of a Claude request at the conversation's level, and the output limit they need. */
function claudeThinking(model: Model<Api>, level: ModelThinkingLevel): Record<string, unknown> {
	// Which form a model takes is known only from its Anthropic settings; no field is always accepted.
	if (model.api !== "anthropic-messages") return {};
	// What this model offers at that level.
	const clamped = clampThinkingLevel(model, level);
	// No thinking asked for or possible.
	if (!model.reasoning || clamped === "off") return {};
	// The same model read as Anthropic's.
	const claude = model as Model<"anthropic-messages">;
	// Current models take an effort level.
	if (claude.compat?.forceAdaptiveThinking === true)
		return { thinking: { type: "adaptive" }, output_config: { effort: mapThinkingLevelToEffort(claude, clamped) } };
	// Older models take a budget, which has to fit inside the output limit.
	const fit = adjustMaxTokensForThinking(REPLY_TOKENS, model.maxTokens, clamped);
	return { max_tokens: fit.maxTokens, thinking: { type: "enabled", budget_tokens: fit.thinkingBudget } };
}

/** Every block of a Claude reply, resuming a turn the server paused. */
async function claudeBlocks(
	call: ServerCall,
	style: ServerStyle,
	tool: BetaToolUnion,
	rules: string,
	prompt: string,
): Promise<BetaContentBlock[]> {
	// The OAuth style uses a bearer token and declares itself.
	const oauth = style === "oauth";
	// The client; retries are the caller's business.
	const client = new PiAnthropic({
		apiKey: oauth ? null : (call.apiKey ?? null),
		authToken: oauth ? (call.apiKey ?? null) : null,
		baseURL: call.baseUrl,
		dangerouslyAllowBrowser: true,
		maxRetries: 0,
		fetch: clientFetch(call),
		defaultHeaders: {
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			...(oauth
				? { "anthropic-beta": OAUTH_BETAS, "user-agent": `claude-cli/${claudeCodeVersion}`, "x-app": "cli" }
				: {}),
			...call.model.headers,
			...call.headers,
		},
	});
	// The OAuth style needs its identity first.
	const system: BetaTextBlockParam[] = [
		...(oauth ? [{ type: "text" as const, text: CLAUDE_IDENTITY }] : []),
		{ type: "text", text: rules },
	];
	// The turn so far.
	const messages: BetaMessageParam[] = [{ role: "user", content: prompt }];
	// Blocks of every round.
	const blocks: BetaContentBlock[] = [];
	for (let round = 0; round < MAX_ROUNDS; round++) {
		// One request, read to the end.
		const reply = await client.beta.messages
			.stream(
				{
					model: call.model.id,
					max_tokens: Math.min(call.model.maxTokens, REPLY_TOKENS),
					system,
					messages,
					tools: [tool],
					...claudeThinking(call.model, call.thinking),
				},
				{ signal: call.signal },
			)
			.finalMessage();
		// Keep them.
		blocks.push(...reply.content);
		// Finished.
		if (reply.stop_reason !== "pause_turn") break;
		// Paused: the reply goes back as it is.
		messages.push({ role: "assistant", content: reply.content as BetaMessageParam["content"] });
	}
	// The whole turn.
	return blocks;
}

/** The sources and text of a Claude search. */
function claudeReport(blocks: readonly BetaContentBlock[]): ServerReport {
	// Each address once.
	const sources = new Map<string, ServerSource>();
	// The upstream's text.
	const text: string[] = [];
	// Tool failures.
	const failures: string[] = [];
	// True once the server really searched.
	let searched = false;
	// Every block.
	for (const block of blocks) {
		if (block.type === "server_tool_use") searched = true;
		else if (block.type === "web_search_tool_result") {
			// A list on success, one error object on failure.
			if (Array.isArray(block.content)) {
				for (const r of block.content)
					addSource(sources, { url: r.url, title: r.title, snippet: "", date: r.page_age ?? "" });
			} else failures.push(block.content.error_code);
		} else if (block.type === "text") {
			text.push(block.text);
			// Citations give the words the text rests on.
			for (const c of block.citations ?? [])
				if (c.type === "web_search_result_location")
					addSource(sources, { url: c.url, title: c.title ?? "", snippet: c.cited_text, date: "" });
		}
	}
	// Nothing came of it.
	if (sources.size === 0 && failures.length > 0) throw new ServerSearchError("tool_error", failures.join(", "));
	// The text alone proves nothing: the upstream may have ignored the tool.
	if (!searched) throw new ServerSearchError("no_search", "");
	// The report.
	return { text: text.join("").trim(), sources: [...sources.values()] };
}

/** Add a source, or fill in what an earlier mention of the address lacked. */
function addSource(sources: Map<string, ServerSource>, source: ServerSource): void {
	// First mention.
	const seen = sources.get(source.url);
	if (!seen) {
		sources.set(source.url, source);
		return;
	}
	// Later mentions complete it.
	seen.title ||= source.title;
	seen.date ||= source.date;
	// Different cited passages add up.
	if (source.snippet && !seen.snippet.includes(source.snippet))
		seen.snippet = seen.snippet ? `${seen.snippet} ${source.snippet}` : source.snippet;
}

/** The page in a Claude fetch. */
function claudePage(blocks: readonly BetaContentBlock[]): ServerPage {
	// Every block.
	for (const block of blocks) {
		if (block.type !== "web_fetch_tool_result") continue;
		// The tool failed.
		if (block.content.type === "web_fetch_tool_result_error")
			throw new ServerSearchError("tool_error", block.content.error_code);
		// The document it read.
		const document = block.content.content;
		// PDFs come back encoded.
		if (document.source.type !== "text") throw new ServerSearchError("pdf", "");
		// The page as fetched.
		return { url: block.content.url, title: document.title ?? "", content: document.source.data };
	}
	// The tool never ran.
	throw new ServerSearchError("no_open", "");
}

/** The account of a Codex login, or undefined when the key holds none. */
function accountOf(key: string | undefined): string | undefined {
	try {
		return extractAccountId(key ?? "");
	} catch {
		// Not every key that works here carries one.
		return undefined;
	}
}

/** The part of a Responses reply this file reads. */
type CodexReply = Pick<Response, "output">;

/** The reasoning field of a Responses request at the conversation's level. */
function codexReasoning(model: Model<Api>, level: ModelThinkingLevel): Record<string, unknown> {
	// Levels probed on another API say nothing here, and no field is always accepted.
	if (!model.api.startsWith("openai") || !model.reasoning) return {};
	// What this model offers at that level.
	const clamped = clampThinkingLevel(model, level);
	// Hosted search refuses reasoning that is off, so the model's default stands.
	if (clamped === "off") return {};
	// Its own name for that level; it also refuses minimal, whose nearest level is low.
	const effort = model.thinkingLevelMap?.[clamped] ?? clamped;
	if (effort === null) return {};
	return { reasoning: { effort: effort === "minimal" ? "low" : effort } };
}

/** A client of one request style; retries are the caller's business. */
function codexClient(call: ServerCall, style: ServerStyle): OpenAI {
	// The OAuth style talks to the Codex backend.
	const oauth = style === "oauth";
	// Its account header, when the key holds one.
	const account = oauth ? accountOf(call.apiKey) : undefined;
	return new OpenAI({
		apiKey: call.apiKey ?? "",
		baseURL: oauth ? resolveCodexUrl(call.baseUrl).replace(/\/responses$/, "") : `${call.baseUrl}/v1`,
		dangerouslyAllowBrowser: true,
		maxRetries: 0,
		fetch: clientFetch(call),
		defaultHeaders: {
			...(oauth ? { originator: "pi", "OpenAI-Beta": "responses=experimental" } : {}),
			...(account ? { "chatgpt-account-id": account } : {}),
			...call.model.headers,
			...call.headers,
		},
	});
}

/** One Responses request with the hosted search tool, read to the end. */
async function codexReply(call: ServerCall, style: ServerStyle, rules: string, prompt: string): Promise<CodexReply> {
	// The client of this style.
	const client = codexClient(call, style);
	// The question.
	const input: ResponseInput = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
	// Live search, as Codex sends it; instructions and no storage suit both styles. The raw stream, because the
	// SDK's stream helper throws on any event outside its own list, and upstreams send others.
	const stream = await client.responses.create(
		{
			model: call.model.id,
			instructions: rules,
			input,
			tools: [{ type: "web_search", external_web_access: true }],
			include: [CODEX_INCLUDE],
			store: false,
			stream: true,
			...codexReasoning(call.model, call.thinking),
		},
		{ signal: call.signal },
	);
	// Finished items as they arrive: some upstreams end with an empty output list.
	const items: Response["output"] = [];
	// The final response, when one comes.
	let final: Response | undefined;
	for await (const event of stream) {
		// Other events carry nothing the result needs.
		if (event.type === "response.output_item.done") items.push(event.item);
		else if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response;
		else if (event.type === "response.failed")
			throw new ServerSearchError("upstream", cleanMessage(event.response.error?.message ?? "failed", call.apiKey));
		else if (event.type === "error")
			throw new ServerSearchError("upstream", cleanMessage(event.message, call.apiKey));
	}
	// The final list when it has anything, else what arrived on the way.
	return { output: final?.output.length ? final.output : items };
}

/** The text of a Responses reply, and the sources it cites. */
function codexText(reply: CodexReply, sources: Map<string, ServerSource>): string {
	// The upstream's text.
	const text: string[] = [];
	// Every output item.
	for (const item of reply.output) {
		if (item.type !== "message") continue;
		for (const part of item.content) {
			if (part.type !== "output_text") continue;
			text.push(part.text);
			// Citations name the pages.
			for (const note of part.annotations)
				if (note.type === "url_citation")
					addSource(sources, { url: note.url, title: note.title, snippet: "", date: "" });
		}
	}
	// All of it.
	return text.join("").trim();
}

/** The sources and text of a Codex search. */
function codexReport(reply: CodexReply): ServerReport {
	// Each address once.
	const sources = new Map<string, ServerSource>();
	// True once the server really searched.
	let searched = false;
	// Search items list what was consulted.
	for (const item of reply.output) {
		if (item.type !== "web_search_call") continue;
		searched = true;
		if (item.action?.type === "search")
			for (const s of item.action.sources ?? [])
				addSource(sources, { url: s.url, title: "", snippet: "", date: "" });
		// A page it opened is the source it read most closely.
		if (item.action?.type === "open_page" && item.action.url)
			addSource(sources, { url: item.action.url, title: "", snippet: "", date: "" });
	}
	// The text alone proves nothing: the upstream may have ignored the tool.
	if (!searched) throw new ServerSearchError("no_search", "");
	// The report.
	return { text: codexText(reply, sources), sources: [...sources.values()] };
}

/** The page in a Codex reply: the model's own writing, once a page was really opened. */
function codexPage(reply: CodexReply, url: string): ServerPage {
	// A redirect or a changed parameter is no failure, so the address is not compared.
	const opened = reply.output.some((item) => item.type === "web_search_call" && item.action?.type === "open_page");
	if (!opened) throw new ServerSearchError("no_open", "");
	// What the model wrote.
	const content = codexText(reply, new Map());
	// Nothing was written, or a line saying the page could not be given: that is no page, and it is not kept.
	if (content.length < MIN_PAGE) throw new ServerSearchError("no_open", content);
	// The page.
	return { url, title: "", content };
}

/** What Codex's own search endpoint gives back: the tool's text, and the results it comes from. */
interface DirectReply {
	// The text as the tool wrote it, with page text in it.
	output: string;
	// The results, each with at least an address; other fields can change.
	results: { url?: unknown; title?: unknown }[];
}

/** One request to Codex's own search endpoint, as Codex sends it: no reasoning, and the session's id. */
async function directReply(
	call: ServerCall,
	style: ServerStyle,
	commands: Record<string, unknown>,
	input: string,
): Promise<DirectReply> {
	// The JSON reply; the client adds the key and fails on a bad status.
	const reply = await codexClient(call, style).post<unknown>("/alpha/search", {
		body: {
			id: call.direct?.id,
			model: call.model.id,
			input,
			commands: { ...commands, response_length: "long" },
			settings: { external_web_access: true, allowed_callers: ["direct"], search_context_size: "high" },
			max_output_tokens: MAX_DIRECT_TOKENS,
		},
		signal: call.signal,
	});
	// An address that answers something else has no such endpoint.
	const { output, results } = (reply ?? {}) as { output?: unknown; results?: unknown };
	if (typeof output !== "string") throw new Error("the search endpoint gave no output");
	return { output, results: Array.isArray(results) ? results : [] };
}

/** The sources of a reply from the endpoint, each address once. */
function directSources(reply: DirectReply): ServerSource[] {
	// Each address once, as everywhere.
	const sources = new Map<string, ServerSource>();
	for (const r of reply.results) {
		// A result of an unknown kind may have no address.
		if (typeof r?.url !== "string" || !r.url) continue;
		addSource(sources, { url: r.url, title: typeof r.title === "string" ? r.title : "", snippet: "", date: "" });
	}
	return [...sources.values()];
}

/** The sources and text of a search through the endpoint. */
function directReport(reply: DirectReply): ServerReport {
	// The tool's text.
	const text = reply.output.trim();
	// Nothing at all: the hosted tool is worth a try.
	if (!text) throw new Error("the search endpoint gave an empty output");
	return { text, sources: directSources(reply) };
}

/** A page read through the endpoint; its first result knows the address behind a reference. */
function directPage(reply: DirectReply, url: string, options: ServerPageOptions): ServerPage {
	// The tool's text.
	const content = reply.output.trim();
	// Part of a page may be short; the start of one this short is an error text rather than the page.
	const part = options.find !== undefined || options.lineno !== undefined;
	if (content.length < (part ? 1 : MIN_PAGE)) throw new ServerSearchError("no_open", content);
	// The result that names the page.
	const first = directSources(reply)[0];
	return { url: first?.url ?? url, title: first?.title ?? "", content };
}

/** Codex's own endpoint when this address takes it, else the hosted tool, for the rest of the session. */
async function viaDirect<T>(
	call: ServerCall,
	direct: (style: ServerStyle) => Promise<T>,
	hosted: () => Promise<T>,
): Promise<T> {
	// Only for callers that allow it, and only until an address refuses.
	if (!call.direct || call.direct.refused.has(call.baseUrl)) return hosted();
	// For the time it took.
	const started = Date.now();
	try {
		// The style the hosted tool found, else plain: one request, because the hosted tool is there to fall back on.
		return await direct(call.styles.get(`codex\n${call.baseUrl}`) ?? "plain");
	} catch (error) {
		// Stopped by the caller, or an answer about this page.
		if (call.signal?.aborted || error instanceof ServerSearchError) throw error;
		// The real error stays in the log.
		callLog(call)?.({ ...failureEntry(error, Date.now() - started), kind: "attempt-failed", style: "direct" });
		call.direct.refused.add(call.baseUrl);
		return hosted();
	}
}

/** A page's own text from Codex's search endpoint, with no model in between; there is no other way to get it. */
export function serverOriginal(call: ServerCall, url: string): Promise<ServerPage> {
	// The style the hosted tool found, else plain.
	const style = call.styles.get(`codex\n${call.baseUrl}`) ?? "plain";
	/** One request: this is on the side, and the caller has other ways. */
	const run = async () => directPage(await directReply(call, style, { open: [{ ref_id: url }] }, url), url, {});
	return recorded(call, "fetch", undefined, run, (out) => ({ title: out.title, contentChars: out.content.length }));
}

/** Let the upstream search; the query goes out as given. */
export function serverSearch(call: ServerCall, query: string, fresh?: ServerFresh): Promise<ServerReport> {
	// The same question for both ways: how far to go is in the rules. The time window, where no field takes it.
	const prompt = `Research this: ${query}${fresh ? ` Only use sources from the last ${FRESH_DAYS[fresh]} days.` : ""}`;
	/** The question through the hosted tool. */
	const hosted = () =>
		withStyle(call, async (style) => codexReport(await codexReply(call, style, SEARCH_RULES, prompt)));
	/** The question through Codex's own endpoint, which takes the time window as a field. */
	const direct = async (style: ServerStyle) => {
		const search = { q: query, ...(fresh ? { recency: FRESH_DAYS[fresh] } : {}) };
		return directReport(await directReply(call, style, { search_query: [search] }, query));
	};
	// The way asked for.
	const run = () =>
		call.way === "claude"
			? withStyle(call, async (style) =>
					claudeReport(await claudeBlocks(call, style, CLAUDE_SEARCH, SEARCH_RULES, prompt)),
				)
			: viaDirect(call, direct, hosted);
	return recorded(call, "search", query, run, (out) => ({
		textChars: out.text.length,
		sources: out.sources.length,
	}));
}

/** Let the upstream read a page; the address goes out as given, inside this request's user message. */
export function serverFetch(call: ServerCall, url: string, options: ServerPageOptions = {}): Promise<ServerPage> {
	// In the user message any address counts as named by the user, wherever it came from.
	const prompt = `Report this page: ${url}`;
	// The hosted tool can only be told what to look for.
	const hostedPrompt = options.find ? `${prompt} Give every passage about: ${options.find}` : prompt;
	/** The page through the hosted tool. */
	const hosted = () =>
		withStyle(call, async (style) => codexPage(await codexReply(call, style, OPEN_RULES, hostedPrompt), url));
	/** The page through Codex's own endpoint, which gives its text as it is. */
	const direct = async (style: ServerStyle) => {
		// Find works on the page by itself, and open takes the line to start from.
		const commands = options.find
			? { find: [{ ref_id: url, pattern: options.find }] }
			: { open: [{ ref_id: url, ...(options.lineno === undefined ? {} : { lineno: options.lineno }) }] };
		return directPage(await directReply(call, style, commands, url), url, options);
	};
	// The way asked for.
	const run = () =>
		call.way === "claude"
			? withStyle(call, async (style) =>
					claudePage(await claudeBlocks(call, style, CLAUDE_FETCH, FETCH_RULES, prompt)),
				)
			: viaDirect(call, direct, hosted);
	// The log says that a page was read, not which.
	return recorded(call, "fetch", undefined, run, (out) => ({
		title: out.title,
		contentChars: out.content.length,
	}));
}
