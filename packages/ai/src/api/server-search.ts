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
import type { Api, Model, ModelThinkingLevel, ProviderHeaders } from "../types.ts";
// The Anthropic client, its OAuth identity and its effort names.
import { claudeCodeVersion, mapThinkingLevelToEffort, PiAnthropic } from "./anthropic-messages.ts";
// The address and account of a Codex login.
import { extractAccountId, resolveCodexUrl } from "./openai-codex-responses.ts";
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
	"Search the web for the query, always, and never answer from memory. Report only what the results say, with the date and the source of each fact.";
/** Instructions of a page read on the "claude" way: the text comes from the tool, not the reply. */
const FETCH_RULES = "Fetch the exact page the user names with the fetch tool, then reply with one short sentence.";
/** Instructions of a page read on the "codex" way: the reply is all there is. */
const OPEN_RULES =
	"Open the exact page the user names with the web search tool, and never answer from memory. Write out the page's full text, word for word, in its own language, with no summary and no comments.";

/** Status of a failed request, or undefined when it never got one. */
function statusOf(error: unknown): number | undefined {
	// The SDKs put it on the error.
	const status = (error as { status?: unknown } | undefined)?.status;
	// Only a number counts.
	return typeof status === "number" ? status : undefined;
}

/** Text of an error with the key taken out. */
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
	// Known from an earlier call.
	const known = call.styles.get(slot);
	if (known) {
		try {
			return await send(known);
		} catch (error) {
			// The upstream changed: find out again next time.
			if (STYLE_STATUSES.has(statusOf(error) ?? 0)) call.styles.delete(slot);
			throw rethrown(call, error);
		}
	}
	// The plain request.
	let first: unknown;
	try {
		const out = await send("plain");
		call.styles.set(slot, "plain");
		return out;
	} catch (error) {
		// Anything but an auth or path error is the answer.
		if (!STYLE_STATUSES.has(statusOf(error) ?? 0)) throw rethrown(call, error);
		first = error;
	}
	// The same key, the OAuth form, once.
	try {
		const out = await send("oauth");
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
	// What this model offers at that level.
	const clamped = clampThinkingLevel(model, level);
	// No thinking asked for or possible.
	if (!model.reasoning || clamped === "off") return {};
	// The same model read as Anthropic's.
	const claude = model as unknown as Model<"anthropic-messages">;
	// Current models take an effort level.
	if (claude.compat?.forceAdaptiveThinking === true)
		return { thinking: { type: "adaptive" }, output_config: { effort: mapThinkingLevelToEffort(claude, clamped) } };
	// Older models take a budget.
	const fit = adjustMaxTokensForThinking(undefined, model.maxTokens, clamped);
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

/** The reasoning field of a Responses request at the conversation's level. */
function codexReasoning(model: Model<Api>, level: ModelThinkingLevel): Record<string, unknown> {
	// Models without reasoning take no such field.
	if (!model.reasoning) return {};
	// What this model offers at that level.
	const clamped = clampThinkingLevel(model, level);
	// Its own name for that level.
	const effort = model.thinkingLevelMap?.[clamped] ?? (clamped === "off" ? "none" : clamped);
	// The model takes no value at this level.
	return effort === null ? {} : { reasoning: { effort } };
}

/** One Responses request with the hosted search tool, read to the end. */
async function codexReply(call: ServerCall, style: ServerStyle, rules: string, prompt: string): Promise<Response> {
	// The OAuth style talks to the Codex backend.
	const oauth = style === "oauth";
	// Its account header, when the key holds one.
	const account = oauth ? accountOf(call.apiKey) : undefined;
	// The client; retries are the caller's business.
	const client = new OpenAI({
		apiKey: call.apiKey ?? "",
		baseURL: oauth ? resolveCodexUrl(call.baseUrl).replace(/\/responses$/, "") : `${call.baseUrl}/v1`,
		dangerouslyAllowBrowser: true,
		maxRetries: 0,
		defaultHeaders: {
			...(oauth ? { originator: "pi", "OpenAI-Beta": "responses=experimental" } : {}),
			...(account ? { "chatgpt-account-id": account } : {}),
			...call.model.headers,
			...call.headers,
		},
	});
	// The question.
	const input: ResponseInput = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
	// Live search, as Codex sends it; instructions and no storage suit both styles.
	return client.responses
		.stream(
			{
				model: call.model.id,
				instructions: rules,
				input,
				tools: [{ type: "web_search", external_web_access: true }],
				include: [CODEX_INCLUDE],
				store: false,
				...codexReasoning(call.model, call.thinking),
			},
			{ signal: call.signal },
		)
		.finalResponse();
}

/** The text of a Responses reply, and the sources it cites. */
function codexText(reply: Response, sources: Map<string, ServerSource>): string {
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
function codexReport(reply: Response): ServerReport {
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
	}
	// The text alone proves nothing: the upstream may have ignored the tool.
	if (!searched) throw new ServerSearchError("no_search", "");
	// The report.
	return { text: codexText(reply, sources), sources: [...sources.values()] };
}

/** The page in a Codex reply: the model's own writing, once a page was really opened. */
function codexPage(reply: Response, url: string): ServerPage {
	// A redirect or a changed parameter is no failure, so the address is not compared.
	const opened = reply.output.some((item) => item.type === "web_search_call" && item.action?.type === "open_page");
	if (!opened) throw new ServerSearchError("no_open", "");
	// What the model wrote.
	const content = codexText(reply, new Map());
	// Nothing was written.
	if (!content) throw new ServerSearchError("no_open", "");
	// The page.
	return { url, title: "", content };
}

/** Let the upstream search; the query goes out as given. */
export function serverSearch(call: ServerCall, query: string): Promise<ServerReport> {
	// The words Claude Code uses, and the same for Codex.
	const prompt = `Perform a web search for the query: ${query}`;
	// The way asked for.
	return withStyle(call, async (style) =>
		call.way === "claude"
			? claudeReport(await claudeBlocks(call, style, CLAUDE_SEARCH, SEARCH_RULES, prompt))
			: codexReport(await codexReply(call, style, SEARCH_RULES, prompt)),
	);
}

/** Let the upstream read a page; the address goes out as given, inside this request's user message. */
export function serverFetch(call: ServerCall, url: string): Promise<ServerPage> {
	// In the user message any address counts as named by the user, wherever it came from.
	const prompt = `Read this page: ${url}`;
	// The way asked for.
	return withStyle(call, async (style) =>
		call.way === "claude"
			? claudePage(await claudeBlocks(call, style, CLAUDE_FETCH, FETCH_RULES, prompt))
			: codexPage(await codexReply(call, style, OPEN_RULES, prompt), url),
	);
}
