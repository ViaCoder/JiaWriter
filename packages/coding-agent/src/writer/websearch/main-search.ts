/**
 * The upstream's own search tools in the main conversation, as Claude Code and Codex use them: the conversation's
 * model reads the pages itself, with no second model retelling them. A tool the upstream refuses would fail the
 * whole conversation, so a tool is only added once a request of its own has shown this upstream takes it. Claude's
 * thinking blocks are bound to the set of tools, so there a shown tool waits for the next conversation.
 */

// The name of an upstream in the record.
import { createHash } from "node:crypto";
// The record between sessions.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Its folder.
import { dirname } from "node:path";
// The conversation's messages.
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
// One search result.
import type { SearchResult } from "./core.ts";

/** Which upstream tools the conversation's API can carry. */
export type MainWay = "claude" | "codex";

/** What a tool does. */
export type MainTool = "search" | "fetch";

/** Upstream tools shown to work, by upstream, kept between sessions. */
export type ProvenRecord = Record<string, MainTool[]>;

/** A Claude conversation's upstream tools: fixed by its first request, for as long as it lasts. */
export interface FixedTools {
	// The upstream and model they were fixed for.
	id: string;
	// The tools.
	tools: MainTool[];
}

/** A page whose text came back with the tool. */
export interface MainPage {
	// Its address.
	url: string;
	// Its title ("" when none).
	title: string;
	// Its text.
	content: string;
}

/** What the upstream's tools did in one reply. */
export interface MainSearch {
	// The questions searched.
	queries: string[];
	// The results listed.
	sources: SearchResult[];
	// Pages the model opened.
	opened: string[];
	// Pages whose text came back; Codex gives none.
	pages: MainPage[];
}

/** Searches in one reply: with fetches below 10, the upstream's own loop of 10 rounds rarely pauses. */
const CLAUDE_SEARCHES = 5;
/** Pages read in one reply. */
const CLAUDE_FETCHES = 4;
/** Added to our own search tool while the upstream's is there: a model with both took ours (seen on 2026-11-06). */
const OWN_TOOL_NOTE = "\n - For upstream search use the web_search tool instead, unless the user names another method";
/** Sources are only listed when asked for. */
const CODEX_SOURCES = "web_search_call.action.sources";

/** The upstream tools an API can carry, if any. */
export function mainWay(api: string | undefined): MainWay | undefined {
	if (api === "anthropic-messages") return "claude";
	return api === "openai-responses" || api === "openai-codex-responses" ? "codex" : undefined;
}

/** The tools to add to a request, of those shown to work. */
export function mainTools(way: MainWay, proven: ReadonlySet<MainTool>): Record<string, unknown>[] {
	// Codex's one tool also opens pages.
	if (way === "codex") return proven.size > 0 ? [{ type: "web_search", external_web_access: true }] : [];
	return [
		...(proven.has("search") ? [{ type: "web_search_20250305", name: "web_search", max_uses: CLAUDE_SEARCHES }] : []),
		...(proven.has("fetch") ? [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: CLAUDE_FETCHES }] : []),
	];
}

/** The reasoning a request with Codex's tool can have: the tool refuses none and minimal, as in a search of its own. */
export function searchReasoning(reasoning: unknown): Record<string, unknown> {
	// The effort asked for.
	const effort = (reasoning as { effort?: unknown } | undefined)?.effort;
	if (effort === "none") return {};
	if (effort === "minimal") return { reasoning: { ...(reasoning as object), effort: "low" } };
	return reasoning === undefined ? {} : { reasoning };
}

/** One of the conversation's tools, told when to leave the search to the upstream's. */
export function steered(tool: unknown): unknown {
	const own = tool as { name?: string; description?: string };
	return own.name === "search_web" ? { ...own, description: `${own.description ?? ""}${OWN_TOOL_NOTE}` } : tool;
}

/** A request body with the tools added, or undefined to leave it alone. */
export function withMainSearch(
	payload: unknown,
	way: MainWay,
	proven: ReadonlySet<MainTool>,
): Record<string, unknown> | undefined {
	const body = payload as { tools?: unknown; include?: unknown; reasoning?: unknown };
	// A request without tools, such as a summary, has no use for them.
	if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined;
	const added = mainTools(way, proven);
	if (added.length === 0) return undefined;
	const tools = [...body.tools.map(steered), ...added];
	if (way === "claude") return { ...body, tools };
	// Without its reasoning field when that is refused.
	const { reasoning: _reasoning, ...rest } = body;
	const include = [...new Set([...(Array.isArray(body.include) ? body.include : []), CODEX_SOURCES])];
	return { ...rest, ...searchReasoning(body.reasoning), tools, include };
}

/** One record, in the fields read here. */
interface ServerItem {
	type?: string;
	name?: string;
	input?: { query?: unknown; url?: unknown };
	action?: { type?: string; query?: unknown; queries?: unknown; url?: unknown; sources?: { url?: unknown }[] };
	content?: unknown;
}

/** One result of Claude's search. */
interface ClaudeResult {
	url?: unknown;
	title?: unknown;
	page_age?: unknown;
}

/** One result of Claude's fetch. */
interface ClaudeFetched {
	url?: unknown;
	content?: { title?: unknown; source?: { type?: unknown; data?: unknown } };
}

/** An upstream's name in the record: a hash, so no address is kept on disk. */
export function provenId(baseUrl: string | undefined, modelId: string | undefined): string {
	return createHash("sha256").update(`${baseUrl}\n${modelId}`).digest("hex").slice(0, 32);
}

/** The record; a missing or broken file counts as nothing shown. */
export function readProven(file: string): ProvenRecord {
	try {
		// Only arrays of known tools count.
		const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
		const out: ProvenRecord = {};
		for (const [id, tools] of Object.entries(raw)) {
			if (Array.isArray(tools)) out[id] = tools.filter((t): t is MainTool => t === "search" || t === "fetch");
		}
		return out;
	} catch {
		// Not there yet, or not readable.
		return {};
	}
}

/** Save the record whole, so a crash leaves the old one; a failure only means proving again. */
export function writeProven(file: string, record: ProvenRecord): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		// Beside the file, so the rename stays on one filesystem.
		const staged = `${file}.${process.pid}.tmp`;
		writeFileSync(staged, JSON.stringify(record), { mode: 0o600 });
		renameSync(staged, file);
	} catch {
		// The record only saves a request.
	}
}

/** The record with a tool added for an upstream, each tool once. */
export function withProven(record: ProvenRecord, id: string, tool: MainTool): ProvenRecord {
	return { ...record, [id]: [...new Set([...(record[id] ?? []), tool])] };
}

/** The record without an upstream. */
export function withoutProven(record: ProvenRecord, id: string): ProvenRecord {
	const { [id]: _gone, ...rest } = record;
	return rest;
}

/** A conversation's tools: those already fixed for it, else what is on record if nothing depends on the set yet. */
export function fixTools(
	fixed: FixedTools | undefined,
	id: string,
	payload: unknown,
	record: ProvenRecord,
): FixedTools {
	return fixed ?? { id, tools: isOpening(payload) ? (record[id] ?? []) : [] };
}

/** The last fixed set in a session's entries. */
export function fixedFromEntries(entries: readonly unknown[], customType: string): FixedTools | undefined {
	return entries
		.flatMap((e) => {
			const entry = e as { type?: string; customType?: string; data?: FixedTools };
			return entry.type === "custom" && entry.customType === customType && entry.data ? [entry.data] : [];
		})
		.at(-1);
}

/** True for a conversation's first request: nothing the model said is in it, so no reasoning depends on its tools. */
export function isOpening(payload: unknown): boolean {
	const messages = (payload as { messages?: { role?: string }[] }).messages;
	return Array.isArray(messages) && !messages.some((m) => m.role === "assistant");
}

/** The tools a Claude request carries: those fixed for this conversation, or none on another upstream. */
export function fixedFor(fixed: FixedTools | undefined, id: string): Set<MainTool> {
	return new Set(fixed?.id === id ? fixed.tools : []);
}

/** The records of a reply. */
export function serverItems(message: AssistantMessage): ServerItem[] {
	return message.content.flatMap((block) =>
		block.type === "thinking" && (block as ThinkingContent).serverItem
			? [JSON.parse(block.thinkingSignature ?? "{}") as ServerItem]
			: [],
	);
}

/** A value when it is text. */
export function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** A source with the fields it has. */
export function sourceOf(url: unknown, title?: unknown, date?: unknown): SearchResult {
	return { url: textOf(url), title: textOf(title), snippet: "", date: textOf(date) };
}

/** What the upstream's tools did in one reply. */
export function readMainSearch(message: AssistantMessage): MainSearch {
	const out: MainSearch = { queries: [], sources: [], opened: [], pages: [] };
	for (const item of serverItems(message)) {
		if (item.type === "web_search_call") {
			// Codex: what it did, with no page text.
			const action = item.action;
			if (action?.type === "search") {
				out.queries.push(
					textOf(action.query),
					...(Array.isArray(action.queries) ? action.queries.map(textOf) : []),
				);
				out.sources.push(...(action.sources ?? []).map((s) => sourceOf(s.url)));
			} else out.opened.push(textOf(action?.url));
		} else if (item.type === "server_tool_use") {
			// Claude: the call.
			if (item.name === "web_search") out.queries.push(textOf(item.input?.query));
			else if (item.name === "web_fetch") out.opened.push(textOf(item.input?.url));
		} else if (item.type === "web_search_tool_result" && Array.isArray(item.content)) {
			// Claude: the results; an error is no list.
			out.sources.push(...(item.content as ClaudeResult[]).map((r) => sourceOf(r.url, r.title, r.page_age)));
		} else if (item.type === "web_fetch_tool_result") {
			// Claude: the page, in plain text unless it is a document such as a PDF.
			const fetched = item.content as ClaudeFetched | undefined;
			const body = fetched?.content?.source;
			if (body?.type === "text" && textOf(body.data)) {
				const page = {
					url: textOf(fetched?.url),
					title: textOf(fetched?.content?.title),
					content: textOf(body.data),
				};
				out.pages.push(page);
			}
		}
	}
	// Each once, and only real values.
	return {
		queries: [...new Set(out.queries.filter(Boolean))],
		sources: out.sources.filter((s) => s.url),
		opened: [...new Set(out.opened.filter(Boolean))],
		pages: out.pages.filter((p) => p.url),
	};
}

/** The reply's own words. */
export function replyText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Addresses a reply cites in its words: besides the opened ones, these are the pages it used. */
export function citedAddresses(message: AssistantMessage): string[] {
	// Up to a space or a mark that ends a link.
	return [...new Set(replyText(message).match(/https?:\/\/[^\s)\]>"'，。；）】]+/g) ?? [])];
}
