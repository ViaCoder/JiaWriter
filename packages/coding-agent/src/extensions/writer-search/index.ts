/**
 * Built-in JiaWriter extension: search_web and fetch_web. The model picks the method of every call,
 * there is no default: search_web browser (the user's Chrome through the JiaWriter extension; engines
 * Bing, Google, Baidu, Sogou, 3–5 pages each, ranked locally), anysearch, claude or codex; fetch_web
 * browser, anysearch, sf (search_fetch), claude or codex. claude and codex let the upstream model
 * do the work in a request of its own, with the conversation's model and thinking level. Once that
 * worked, the upstream's own tools join the main conversation where its API can carry them.
 */

// The marker that the extension was seen once.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
// Home folder for Chrome's host folders.
import { homedir } from "node:os";
// Folder of the running binary (release layout of sf), and paths.
import { dirname, join } from "node:path";
// The conversation's messages.
import type { AssistantMessage } from "@earendil-works/pi-ai";
// Search and page reads by the upstream.
import {
	type ServerCall,
	type ServerStyle,
	type ServerWay,
	serverFetch,
	serverOriginal,
	serverSearch,
} from "@earendil-works/pi-ai/api/server-search.lazy";
// The record of a search.
import { hostsOf, secretsOf, serverLog } from "@earendil-works/pi-ai/api/server-trace";
// Parameter schemas.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
// Plain text in the interface.
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// Agent directory, binary detection, the extension folder.
import { getAgentDir, getWriterExtensionDir, isBunBinary, VERSION } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// How a tool call is shown.
import { formatToolCallWithArgs } from "../../core/tools/render-utils.ts";
// The bridge to Chrome.
import { bridgeAddress, bridgeCall } from "../../writer/browser/bridge.ts";
// Host registration and starting Chrome.
// Engine names.
import { ALL_ENGINES, type EngineName, parseEngines } from "../../writer/browser/engines.ts";
// fetch_web through Chrome.
import { browserFetch } from "../../writer/browser/fetch.ts";
import { ensureHost, startChrome } from "../../writer/browser/install.ts";
// Request pacing.
import { pace } from "../../writer/browser/pacing.ts";
// search_web through Chrome.
import {
	type BrowserDeps,
	browserSearch,
	clampPages,
	DEFAULT_TIMING,
	type SerpTab,
	VERIFY_COOLDOWN_MS,
} from "../../writer/browser/search.ts";
// The current time for reports.
import { nowText } from "../../writer/clock.ts";
// Addresses compared as the reference check does.
import { normalizeUrl } from "../../writer/export/refs.ts";
// Output messages.
import { currentLang, t } from "../../writer/i18n/index.ts";
// Secrets are taken out of upstream errors.
import { redactSecrets } from "../../writer/redact.ts";
// The AnySearch key held in memory.
import { withSecrets } from "../../writer/secrets.ts";
// The research archive.
import { ensureTopic } from "../../writer/topic/current.ts";
import { archivedUrls, archiveFiltered, archivePage, archiveSearch } from "../../writer/topic/topic.ts";
// AnySearch backend.
import { anysearchExtract, anysearchSearch } from "../../writer/websearch/anysearch.ts";
// Arguments as models send them.
import { cleanFetchArgs, cleanSearchArgs, shownSearchArgs } from "../../writer/websearch/args.ts";
// Configuration, normalization and reports.
import {
	cleanWebText,
	type FetchResult,
	formatFetch,
	formatSearch,
	isHttpUrl,
	normalizeResults,
	readSearchEnv,
	type SearchResult,
} from "../../writer/websearch/core.ts";
// The search log.
import { appendSearchLog } from "../../writer/websearch/log.ts";
// The upstream's own tools in the main conversation.
import {
	citedAddresses,
	type MainTool,
	type MainWay,
	mainWay,
	readMainSearch,
	replyText,
	withMainSearch,
} from "../../writer/websearch/main-search.ts";
// sf backend.
import { locateSf, parseSfFetch, runSf, sfChildEnv, sfError } from "../../writer/websearch/sf.ts";
// The configured model's name.
import { getWriterModel } from "../../writer/writer-model.ts";

/** How long to wait for Chrome to connect after starting it (ms). */
const CHROME_START_WAIT_MS = 20_000;
/** Shortest gap between two AnySearch requests (ms); several at once make it fail (the user, 2026-11-05). */
const ANYSEARCH_GAP_MS = 1000;
/** Most pages fetched for the archive after one reply. */
const MAX_ORIGINS = 8;
/** Most resumes of a paused reply in a row: a guard against one that never ends. */
const MAX_RESUMES = 3;

/** Engine names as shown to the user. */
function engineName(engine: string): string {
	// Chinese names for the Chinese engines in the Chinese interface.
	const zh = currentLang() === "zh";
	const names: Record<string, string> = {
		bing: "Bing",
		google: "Google",
		baidu: zh ? "百度" : "Baidu",
		sogou: zh ? "搜狗" : "Sogou",
	};
	return names[engine] ?? (zh ? "网页" : "The page");
}

/** A method the model may name. */
type Method = "browser" | "anysearch" | "sf" | ServerWay;

/** Upstream failures by kind; the two that carry a detail name it. */
const SERVER_ERRORS = {
	no_search: "server.noSearch",
	no_open: "server.noOpen",
	tool_error: "server.toolError",
	pdf: "server.pdf",
	upstream: "server.upstream",
} as const;

/** True for the methods the upstream serves. */
function isServerWay(method: Method | undefined): method is ServerWay {
	return method === "claude" || method === "codex";
}

/** An upstream failure as the model reads it, without secrets; a cancelled call stays as it is. */
function serverFailure(error: unknown): unknown {
	// Its kind, when it has one.
	const code = (error as { code?: string }).code ?? "";
	// Not one of ours.
	if (!(code in SERVER_ERRORS)) return error;
	// Named, with the detail cleaned.
	const key = SERVER_ERRORS[code as keyof typeof SERVER_ERRORS];
	return new Error(t(key, { detail: redactSecrets((error as Error).message) }));
}

/** Hints shared by both tools: they reach the open web and change nothing locally. */
const WEB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** A pause. */
function sleep(ms: number): Promise<void> {
	// Timer promise.
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** work, ended at once when the call is cancelled: a request to Chrome can take up to 40 s to answer. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	// Nothing can cancel it.
	if (!signal) return work;
	if (signal.aborted) {
		// Its own failure no longer matters.
		work.catch(() => undefined);
		return Promise.reject(new Error("aborted"));
	}
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Error("aborted"));
		signal.addEventListener("abort", stop, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
	});
}

/** Extension factory. */
export default function writerSearchExtension(pi: ExtensionAPI): void {
	// Configuration once per session.
	const config = readSearchEnv(withSecrets(process.env));
	// Methods the model has been told about their unused parameters.
	const toldIgnored = new Set<string>();
	// Where the browser host listens, and its private folder.
	const address = bridgeAddress(getAgentDir(), process.platform);
	const browserDir = join(getAgentDir(), "browser");
	// Tag of the tabs this session opens.
	const run = `wa-${process.pid}-${Date.now()}`;
	// Results pages left open by the last browser search.
	let serps: SerpTab[] = [];
	// Whether this session used the browser (its tabs are closed at the end).
	let usedBrowser = false;
	// Engines resting after an uncleared verification: engine → time the rest ends (ms).
	const resting = new Map<EngineName, number>();
	// Sites that held the work for a person in this run.
	const held = new Set<string>();
	// Browser timing with the configured verification wait.
	const timing = { ...DEFAULT_TIMING, humanWaitMs: config.verifyWaitMs };
	// The model the upstream methods are chosen for.
	const state = getWriterModel();
	const configured = state.kind === "ready" ? ` The configured model is ${state.model}.` : "";
	/** The upstream methods in a tool description. */
	const UPSTREAM_METHODS = `claude, codex = the upstream model does it itself.${configured} `;
	// Which request style each upstream took in this session.
	const styles = new Map<string, ServerStyle>();
	// Addresses without Codex's own search endpoint, found in this session.
	const refused = new Set<string>();
	// Upstream tools shown to work, by address and model: only those go into the main conversation.
	const proven = new Map<string, Set<MainTool>>();
	// Pages being fetched for the archive, one after the other, beside the conversation.
	let originQueue: Promise<void> = Promise.resolve();
	// How many of them could not be fetched in this run.
	let originsMissed = 0;
	// Addresses the upstream's own tools listed in this session: a later reply may cite them.
	const listed = new Set<string>();
	// Resumes of a paused reply in a row.
	let resumes = 0;

	/** sf binary and child environment (no driver model, see sfModelOff) for one call. */
	function sfContext(interactive: boolean) {
		// The binary.
		const bin = locateSf(config, process.platform, process.arch, dirname(process.execPath), getAgentDir());
		// Everything a run needs.
		return { bin, env: sfChildEnv(process.env, interactive, getAgentDir()) };
	}

	/** The browser driver's surroundings for one tool call. */
	function deps(ctx: ExtensionContext, signal?: AbortSignal): BrowserDeps {
		return {
			// Each request stops when the call is cancelled.
			call: (op, args, ms) => abortable(bridgeCall(address, op, args, ms), signal),
			// Waits end with the call too: pacing and human pauses can last seconds.
			sleep: (ms) => abortable(sleep(ms), signal),
			random: Math.random,
			pace: async (key, gap) => {
				await pace(join(browserDir, "pacing.json"), key, gap, sleep);
			},
			interactive: ctx.hasUI,
			// Esc on the tool call ends every wait at once.
			aborted: () => signal?.aborted === true,
			// Verification steps are shown in the interface.
			notify: (ev) => {
				if (!ctx.hasUI) return;
				const key = (
					{
						verify: "browser.verify",
						verify_left: "browser.verifyLeft",
						verify_ok: "browser.verifyOk",
						verify_timeout: "browser.verifyTimeout",
						verify_gone: "browser.verifyGone",
					} as const
				)[ev.kind];
				// The terminal bell: the person may be looking somewhere else.
				if (ev.kind === "verify") process.stdout.write("\x07");
				ctx.ui.notify(
					t(key, { engine: engineName(ev.engine), seconds: ev.seconds ?? 0 }),
					ev.kind === "verify_ok" ? "info" : "warning",
				);
			},
			// Each site holds the work once a run.
			claimHold: (site) => {
				if (held.has(site)) return false;
				held.add(site);
				return true;
			},
			// A line that stays while the wait lasts; the notes above scroll away.
			countdown: (seconds) => {
				if (!ctx.hasUI) return;
				ctx.ui.setStatus("jw-verify", seconds > 0 ? t("browser.verifyStatus", { seconds }) : undefined);
			},
			run,
		};
	}

	/** The extension's status, or null when it is not connected. */
	async function browserStatus(): Promise<{ version: string } | null> {
		// One short request.
		try {
			return (await bridgeCall(address, "status", {}, 5000)) as { version: string };
		} catch {
			return null;
		}
	}

	/** True when the browser can be used now; starts Chrome when the extension was set up before. */
	async function browserReady(): Promise<boolean> {
		// Already connected.
		const marker = join(browserDir, "seen");
		if (await browserStatus()) {
			// Remember that this user has the extension.
			if (!existsSync(marker)) {
				mkdirSync(browserDir, { recursive: true });
				writeFileSync(marker, "");
			}
			return true;
		}
		// Never set up: nothing to start.
		if (!existsSync(marker) || !startChrome(process.platform, process.env)) return false;
		// Chrome is starting: wait for the extension.
		for (let waited = 0; waited < CHROME_START_WAIT_MS; waited += 1000) {
			await sleep(1000);
			if (await browserStatus()) return true;
		}
		return false;
	}

	/** Run an archive step in the topic folder: its path as a note, or a note that it failed. */
	function keep(ctx: ExtensionContext, hint: string, write: (dir: string) => string): { dir?: string; note: string } {
		try {
			const dir = ensureTopic(ctx.cwd, hint);
			return { dir, note: t("topic.archived", { path: join(dir, write(dir)) }) };
		} catch (e) {
			return { note: t("topic.archiveFailed", { reason: e instanceof Error ? e.message : String(e) }) };
		}
	}

	/** Wait for AnySearch's turn; the state file keeps several JiaWriter windows apart too. */
	function anysearchTurn(): Promise<number> {
		return pace(join(browserDir, "pacing.json"), "anysearch", ANYSEARCH_GAP_MS, sleep);
	}

	/** The method of one call, always the model's choice; the browser only when it can be used now. */
	async function pick(requested: Method | undefined): Promise<Method> {
		// There is no default.
		if (!requested) throw new Error(t("search.noMethod"));
		// Chrome may be away.
		if (requested === "browser" && !(await browserReady())) throw new Error(t("search.methodUnavailable"));
		// The model's choice.
		return requested;
	}

	/** An upstream request of this conversation: its model, its thinking level, its address and key. */
	async function serverCall(ctx: ExtensionContext, way: ServerWay, signal?: AbortSignal): Promise<ServerCall> {
		// The conversation's model.
		const model = ctx.model;
		if (!model) throw new Error(t("server.noModel"));
		// Its key and headers, held in memory.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		// The address without /v1: each way adds its own path.
		const baseUrl = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
		// Level as the conversation has it now, so /effort takes effect at once.
		return {
			way,
			baseUrl,
			model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			thinking: pi.getThinkingLevel(),
			styles,
			signal,
			log: appendSearchLog,
			// Where the upstream's tool can join the conversation, the request must show that it works.
			direct: mainWay(ctx.model?.api) === "codex" ? undefined : { id: ctx.sessionManager.getSessionId(), refused },
		};
	}

	/** Where a conversation's shown tools are kept. */
	function provenKey(ctx: ExtensionContext): string {
		return `${ctx.model?.baseUrl}\n${ctx.model?.id}`;
	}

	/** Note that a request of its own worked, so the tool can join the conversation; says so to the model once. */
	function prove(ctx: ExtensionContext, way: ServerWay, tool: MainTool): string {
		// A conversation on another API cannot carry it.
		if (mainWay(ctx.model?.api) !== way) return "";
		const key = provenKey(ctx);
		const shown = proven.get(key) ?? new Set<MainTool>();
		proven.set(key, shown);
		if (shown.has(tool)) return "";
		shown.add(tool);
		// Codex's one tool does both.
		if (way === "codex" && shown.size > 1) return "";
		return t("server.mainOn", { tool: way === "claude" && tool === "fetch" ? "web_fetch" : "web_search" });
	}

	/** A page through sf. */
	async function sfPage(ctx: ExtensionContext, url: string, signal?: AbortSignal): Promise<FetchResult> {
		// sf fetch in the working folder (the URL after the separator).
		const sf = sfContext(ctx.hasUI);
		const runOut = await runSf(sf.bin, ["fetch", "--json", "--", url], {
			cwd: ctx.cwd,
			env: sf.env,
			timeoutMs: config.timeoutMs,
			signal,
		});
		if (runOut.code !== 0) throw sfError(runOut, config.timeoutMs);
		return parseSfFetch(runOut.stdout, url);
	}

	/** The server's ways to a page for the archive, best first: moving to another channel is the user's choice. */
	function originWays(ctx: ExtensionContext, way: MainWay, url: string): [string, () => Promise<FetchResult>][] {
		/** A page through a request of its own. */
		const report = async (): Promise<FetchResult> => {
			const out = await serverFetch(await serverCall(ctx, way), url);
			return { url: out.url || url, title: out.title, content: out.content, date: "" };
		};
		// Claude's fetch gives the text itself.
		if (way === "claude") return [["claude", report]];
		/** Codex's endpoint gives it too, where it exists. */
		const endpoint = async (): Promise<FetchResult> => {
			const call = await serverCall(ctx, "codex");
			if (refused.has(call.baseUrl)) throw new Error("no endpoint");
			const direct = { id: ctx.sessionManager.getSessionId(), refused };
			const out = await serverOriginal({ ...call, direct }, url).catch((e: unknown) => {
				// A page can fail on its own; anything else means no endpoint here.
				if ((e as { code?: unknown }).code !== "no_open") refused.add(call.baseUrl);
				throw e;
			});
			return { url: out.url || url, title: out.title, content: out.content, date: "" };
		};
		// Else the fullest report the server can write, marked as what it is.
		return [
			["codex", endpoint],
			[t("server.retold", { way: "codex" }), report],
		];
	}

	/** Keep a page's own text in the topic, by the first way that gives it. */
	async function keepOrigin(ctx: ExtensionContext, way: MainWay, dir: string, url: string): Promise<void> {
		const log = await searchLog(ctx);
		for (const [method, read] of originWays(ctx, way, url)) {
			try {
				const page = await read();
				const content = cleanWebText(page.content);
				if (!content.trim()) continue;
				archivePage(dir, { ...page, title: cleanWebText(page.title), content }, url, method, nowText());
				log({ kind: "origin", method, chars: content.length });
				return;
			} catch (e) {
				// The next way may have it.
				log({ kind: "origin-attempt", method, message: e instanceof Error ? e.message : String(e) });
			}
		}
		originsMissed++;
		log({ kind: "origin-failed" });
	}

	/** Archive what the upstream's own tools did in a reply: the search, and every page read in the original. */
	function recordMainSearch(ctx: ExtensionContext, message: AssistantMessage, way: MainWay): void {
		const found = readMainSearch(message);
		// The search, as any other: the list is what backs materials.
		const results = normalizeResults(found.sources, config.blocklist);
		for (const r of results) listed.add(normalizeUrl(r.url));
		// What the reply cites of all that was listed, also by an earlier reply; a page merely named is left alone.
		const cited = citedAddresses(message).filter((u) => listed.has(normalizeUrl(u)));
		// Nothing happened.
		if (results.length + found.queries.length + found.opened.length + found.pages.length + cited.length === 0) return;
		const query = found.queries.join("；");
		const answer = replyText(message);
		const report = [answer && t("server.text", { text: answer }), formatSearch(query, way, results)];
		const urls = results.map((r) => r.url);
		const body = report.filter(Boolean).join("\n");
		const hint = found.queries[0] ?? found.pages[0]?.title ?? "";
		// A reply that only cites has no search to keep; its pages go into the topic all the same.
		const kept = query
			? keep(ctx, hint, (dir) => archiveSearch(dir, query, body, nowText(), urls))
			: { dir: ensureTopic(ctx.cwd, hint) };
		// Pages that came with their text.
		for (const page of found.pages) {
			const clean = { ...page, title: cleanWebText(page.title), content: cleanWebText(page.content), date: "" };
			keep(ctx, hint, (dir) => archivePage(dir, clean, page.url, way, nowText()));
		}
		// The rest of what it read and cited is fetched beside the conversation.
		const dir = kept.dir;
		if (!dir) return;
		const known = new Set(archivedUrls(dir));
		const wanted = [...found.opened, ...cited].filter((u) => isHttpUrl(u));
		const fresh = [...new Set(wanted)].filter((u) => !known.has(normalizeUrl(u))).slice(0, MAX_ORIGINS);
		for (const url of fresh) originQueue = originQueue.then(() => keepOrigin(ctx, way, dir, url));
	}

	/** The search log of this conversation, cleaned of its keys. */
	async function searchLog(ctx: ExtensionContext) {
		// The conversation's key and headers, when it has a model.
		const auth = ctx.model ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model) : undefined;
		// Everything that must stay out of the file.
		const secrets = auth?.ok ? [...secretsOf(auth.apiKey, auth.headers), ...hostsOf(auth.baseUrl)] : [];
		return serverLog(appendSearchLog, [
			...secrets,
			...hostsOf(ctx.model?.baseUrl),
			...secretsOf(config.anysearchKey),
		]);
	}

	/** Register the host with Chrome (release binaries only; source checkouts use /browser). */
	function registerHost(): string[] {
		return ensureHost({
			platform: process.platform,
			home: homedir(),
			agentDir: getAgentDir(),
			program: isBunBinary ? { binary: process.execPath } : { node: process.execPath, cli: process.argv[1] ?? "" },
		});
	}

	// At startup, a release binary keeps Chrome's host registration current (no network, small files).
	// Each search and fetch as the model called it and what it got, whatever the method.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "search_web" && event.toolName !== "fetch_web") return;
		// The result's own text, as the model reads it.
		const text = event.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
		(await searchLog(ctx))({
			kind: "tool",
			tool: event.toolName,
			// Without the page's address, which may have no form the log can recognize.
			input: { ...event.input, url: undefined },
			error: event.isError,
			text: text.slice(0, 2000),
		});
	});

	// What the conversation's model did each turn: which tools it called, or why it stopped.
	pi.on("turn_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		(await searchLog(ctx))({
			kind: "turn",
			index: event.turnIndex,
			stop: message.stopReason,
			error: message.errorMessage,
			tools: message.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : [])),
			// Records of the upstream's own tools, which are no calls of ours.
			upstreamTools: message.content.filter((c) => c.type === "thinking" && c.serverItem).length,
		});
		const way = mainWay(message.api);
		if (way) recordMainSearch(ctx, message, way);
		// A tool the upstream refused in the conversation must not fail the next request too.
		if (message.stopReason === "error" && /\b400\b|tool|web_search|web_fetch/i.test(message.errorMessage ?? ""))
			proven.delete(provenKey(ctx));
		// The upstream's own loop stopped halfway: the reply goes on.
		if (message.rawStopReason !== "pause_turn") resumes = 0;
		else if (resumes < MAX_RESUMES) {
			resumes++;
			pi.sendMessage(
				{ customType: "jiawriter-search-resume", content: "Continue.", display: false },
				{ deliverAs: "followUp" },
			);
		}
	});

	// The upstream's own tools go into the main conversation once they are shown to work.
	pi.on("before_provider_request", (event, ctx) => {
		const way = mainWay(ctx.model?.api);
		const shown = proven.get(provenKey(ctx));
		return way && shown ? withMainSearch(event.payload, way, shown) : undefined;
	});

	// The conversation ends with the archive complete.
	pi.on("agent_end", async (_event, ctx) => {
		await originQueue;
		if (originsMissed === 0) return;
		const note = t("server.originMissed", { count: originsMissed });
		originsMissed = 0;
		if (ctx.hasUI) ctx.ui.notify(note, "warning");
		else process.stderr.write(`${note}\n`);
	});

	// A shorter or another history may have lost the note about unused parameters.
	pi.on("session_compact", () => toldIgnored.clear());
	pi.on("session_tree", () => toldIgnored.clear());

	// Which program and setup the lines below come from.
	pi.on("session_start", async (_event, ctx) => {
		toldIgnored.clear();
		(await searchLog(ctx))({
			kind: "session",
			version: VERSION,
			platform: process.platform,
			runtime: process.release.name,
			model: ctx.model?.id,
			api: ctx.model?.api,
			thinking: pi.getThinkingLevel(),
		});
	});

	pi.on("session_start", (event) => {
		if (event.reason !== "startup" || !isBunBinary) return;
		try {
			registerHost();
		} catch {
			// Shown by /browser when the user asks.
		}
	});

	// A new message from the user means someone is back: engines resting after a check get another try.
	pi.on("before_agent_start", () => {
		resting.clear();
		held.clear();
	});

	// At the end, close the tabs this session opened.
	pi.on("session_shutdown", async () => {
		if (!usedBrowser) return;
		await bridgeCall(address, "close_run", { run }, 5000).catch(() => undefined);
	});

	// search_web.
	pi.registerTool({
		// Name the model calls.
		name: "search_web",
		// Name shown in the interface.
		label: "Web search",
		// Full description sent to the model.
		description:
			"Search the web. browser = the user's Chrome; takes engines, pages, fresh. anysearch = API; takes zone, language. " +
			`${UPSTREAM_METHODS}` +
			"Each method uses only its own parameters.",
		// Argument schema.
		parameters: Type.Object({
			query: Type.String(),
			method: StringEnum(["browser", "anysearch", "claude", "codex"] as const),
			engines: Type.Optional(
				Type.Array(StringEnum(ALL_ENGINES), { description: "browser only, in order; default bing, google" }),
			),
			pages: Type.Optional(Type.Number({ description: "browser only: results pages per engine, 3–5" })),
			fresh: Type.Optional(
				StringEnum(["day", "week", "month", "year"] as const, { description: "browser and codex only" }),
			),
			zone: Type.Optional(StringEnum(["cn", "intl"] as const, { description: "anysearch only" })),
			language: Type.Optional(Type.String({ description: "anysearch only, such as zh-CN" })),
		}),
		// Models fill in fields of other methods: each call keeps only what its method uses.
		prepareArguments: (args) => cleanSearchArgs(args) as never,
		// The call as it took effect; a model's unused fields would read as if they had been sent.
		renderCall: (args, theme, context) =>
			new Text(formatToolCallWithArgs("search_web", shownSearchArgs(args), theme, context.expanded), 0, 0),
		// Read-only, open world.
		annotations: WEB,
		// One at a time: AnySearch fails on parallel requests, and the browser shares one results tab.
		executionMode: "sequential",
		// Run the search.
		async execute(_id, params, signal, _onUpdate, ctx) {
			// A query is required.
			if (!params.query?.trim()) throw new Error(t("search.noQuery"));
			// The backend for this call.
			const backend = await pick(params.method);
			// Raw results, backend label, notes and the upstream's own answer.
			let raw: SearchResult[];
			let label: string = backend;
			const notes: string[] = [];
			let answer = "";
			// Parameters this method does not use: the model is told, so it does not count on them.
			const ignored = (params as { ignored?: string[] }).ignored ?? [];
			// Once per method: strict models fill every field on every call, and the line would repeat for nothing.
			if (ignored.length > 0 && !toldIgnored.has(backend)) {
				toldIgnored.add(backend);
				notes.push(t("search.ignored", { method: backend, names: ignored.join(", ") }));
			}
			if (backend === "browser") {
				usedBrowser = true;
				// The previous results pages are closed first.
				for (const s of serps) await bridgeCall(address, "close", { tab: s.tab }, 10_000).catch(() => undefined);
				serps = [];
				// Bing, then Google.
				// The model's engines, else JW_ENGINES.
				const engines = params.engines?.length ? parseEngines(params.engines) : config.engines;
				// Two engines have no year filter.
				const noYear = params.fresh === "year" ? engines.filter((e) => e === "bing" || e === "sogou") : [];
				if (noYear.length > 0) notes.push(t("search.noYear", { engines: noYear.map(engineName).join(", ") }));
				// Engines still resting after an uncleared verification.
				const now = Date.now();
				for (const [e, until] of resting) if (until <= now) resting.delete(e);
				const out = await browserSearch(deps(ctx, signal), params.query, {
					engines,
					pages: clampPages(params.pages ?? config.pages),
					fresh: params.fresh,
					timing,
					resting: new Set(resting.keys()),
				});
				// An uncleared verification rests that engine.
				for (const o of out.outcomes)
					if (o.stopped === "verification") resting.set(o.engine, Date.now() + VERIFY_COOLDOWN_MS);
				serps = out.outcomes.flatMap((o) => (o.serp ? [o.serp] : []));
				raw = out.ranked.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, date: "" }));
				// Label "Bing 3 页、Google 3 页" and the engines that stopped early.
				label = t("browser.label", {
					detail: out.outcomes
						.map((o) => t("browser.engineLine", { engine: engineName(o.engine), pages: o.pages }))
						.join(currentLang() === "zh" ? "、" : ", "),
				});
				for (const o of out.outcomes)
					if (o.stopped)
						notes.push(
							t("browser.stopped", {
								engine: engineName(o.engine),
								pages: o.pages,
								reason:
									o.stopped === "verification"
										? t("browser.reason.verification")
										: o.stopped === "verification (resting)"
											? t("browser.reason.resting")
											: o.stopped,
							}),
						);
			} else if (isServerWay(backend)) {
				// The upstream searches.
				const call = await serverCall(ctx, backend, signal);
				const out = await serverSearch(call, params.query, params.fresh).catch((e: unknown) => {
					throw serverFailure(e);
				});
				raw = out.sources;
				answer = out.text;
				notes.push(prove(ctx, backend, "search"));
			} else {
				// AnySearch.
				await anysearchTurn();
				raw = await anysearchSearch(config, params.query, { zone: params.zone, language: params.language }, signal);
			}
			// Every result goes in: the model chooses among them.
			const results = normalizeResults(raw, config.blocklist);
			// Report: the upstream's answer, when there is one, then the list.
			const report = [answer && t("server.text", { text: answer }), formatSearch(params.query, label, results)]
				.filter(Boolean)
				.join("\n");
			// The search is kept in the topic folder; a full disk must not cost the result.
			const urls = results.map((r) => r.url);
			const kept = keep(ctx, params.query, (dir) => archiveSearch(dir, params.query, report, nowText(), urls));
			const text = [...notes, report, kept.note].filter(Boolean).join("\n");
			// Text and structured results.
			return { content: [{ type: "text", text }], details: { backend, results, topicDir: kept.dir } };
		},
	});

	// fetch_web.
	pi.registerTool({
		// Name the model calls.
		name: "fetch_web",
		// Name shown in the interface.
		label: "Web fetch",
		// Full description sent to the model.
		description:
			"Fetch a page's main text. browser = the user's Chrome, for news and JavaScript pages. anysearch = API. " +
			"sf = PDF, Word and Excel links, video pages. " +
			UPSTREAM_METHODS.trim(),
		// Argument schema.
		parameters: Type.Object({
			url: Type.String(),
			method: StringEnum(["browser", "anysearch", "sf", "claude", "codex"] as const),
			lineno: Type.Optional(Type.Number({ description: "codex only: the line to read from" })),
			find: Type.Optional(Type.String({ description: "codex only: words to find in the page" })),
		}),
		// Read-only, open world.
		annotations: WEB,
		// The method in the form the schema uses.
		prepareArguments: (args) => cleanFetchArgs(args) as never,
		// One at a time, like search_web.
		executionMode: "sequential",
		// Fetch the page.
		async execute(_id, params, signal, _onUpdate, ctx) {
			// The upstream takes any address as it is; the local methods need a web address.
			if (!isServerWay(params.method) && !isHttpUrl(params.url))
				throw new Error(t("fetch.badUrl", { url: params.url }));
			// The backend for this call.
			const backend = await pick(params.method);
			// The page from the backend.
			let page: FetchResult;
			// A note when the upstream's own tool joins the conversation.
			let joined = "";
			if (backend === "browser") {
				usedBrowser = true;
				page = await browserFetch(deps(ctx, signal), params.url, serps, timing);
			} else if (backend === "sf") {
				page = await sfPage(ctx, params.url, signal);
			} else if (isServerWay(backend)) {
				// The upstream reads it.
				const call = await serverCall(ctx, backend, signal);
				const part = { lineno: params.lineno, find: params.find };
				const out = await serverFetch(call, params.url, part).catch((e: unknown) => {
					throw serverFailure(e);
				});
				page = { url: out.url || params.url, title: out.title, content: out.content, date: "" };
				joined = prove(ctx, backend, "fetch");
			} else {
				// AnySearch extract.
				await anysearchTurn();
				page = await anysearchExtract(config, params.url, signal);
			}
			// What a reader cannot see goes before anything keeps or reads the text.
			page = { ...page, title: cleanWebText(page.title), content: cleanWebText(page.content) };
			// The whole page is kept in the topic folder, also what the report below leaves out.
			const filtered = page.filtered ?? [];
			let filteredFile = "";
			// A part of a page has its own entry, because a second read of an address replaces the file.
			const section = params.find ? `#find=${params.find}` : params.lineno ? `#line=${params.lineno}` : "";
			const kept = keep(ctx, page.title, (dir) => {
				const file = archivePage(dir, { ...page, url: `${page.url}${section}` }, params.url, backend, nowText());
				if (filtered.length > 0) filteredFile = join(dir, archiveFiltered(dir, file, filtered));
				return file;
			});
			// Where the left-out text is, in case the page reads as incomplete.
			const left = filteredFile
				? t("topic.filtered", {
						count: filtered.length,
						chars: filtered.reduce((sum, x) => sum + x.length, 0),
						path: filteredFile,
					})
				: "";
			// Report (with the notes) and structured page (without the long text).
			const unsure = page.unsure ? t("browser.unsure", { url: params.url }) : "";
			const text = [formatFetch(page, backend), unsure, joined, kept.note, left].filter(Boolean).join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					backend,
					url: page.url,
					title: page.title,
					date: page.date,
					chars: page.content.length,
					topicDir: kept.dir,
				},
			};
		},
	});

	/** /browser (and /sf): register the host, then show the connection state and the install steps. */
	async function showBrowser(ctx: ExtensionContext): Promise<void> {
		// Lines of the report.
		const lines: string[] = [];
		// Registration (also from a source checkout, on request).
		try {
			const written = registerHost();
			if (written.length > 0) lines.push(t("browser.hostOk", { files: written.join(", ") }));
		} catch (e) {
			lines.push(t("browser.hostFailed", { reason: e instanceof Error ? e.message : String(e) }));
		}
		// Connection.
		const st = await browserStatus();
		lines.push(st ? t("browser.connected", { version: st.version }) : t("browser.disconnected"));
		// The steps while it is not connected.
		if (!st) lines.push(t("browser.steps", { dir: getWriterExtensionDir() }));
		ctx.ui.notify(lines.join("\n"), st ? "info" : "warning");
	}

	// /browser.
	pi.registerCommand("browser", {
		description: "Chrome extension of the browser search backend: connection state and install steps",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(t("browser.cmdUsage"), "error");
				return;
			}
			await showBrowser(ctx);
		},
	});

	// /sf status|install: the same page (sf's pages go through the same extension and host).
	pi.registerCommand("sf", {
		description: "search_fetch uses the same Chrome extension: /sf status or /sf install shows /browser",
		getArgumentCompletions: (prefix) =>
			["status", "install"].filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a })),
		handler: async (args, ctx) => {
			const op = args.trim() || "status";
			if (op !== "status" && op !== "install") {
				ctx.ui.notify(t("sf.cmdUsage"), "error");
				return;
			}
			await showBrowser(ctx);
		},
	});
}
