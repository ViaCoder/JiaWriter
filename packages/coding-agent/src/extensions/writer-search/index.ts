/**
 * Built-in JiaWriter extension: web_search and web_fetch. The model picks the method of every call,
 * there is no default: web_search browser (the user's Chrome through the JiaWriter extension; engines
 * Bing, Google, Baidu, Sogou, 3–5 pages each, ranked locally), anysearch, claude or codex; web_fetch
 * browser, anysearch, sf (search_fetch), claude or codex. claude and codex let the upstream model
 * do the work in a request of its own, with the conversation's model and thinking level.
 */

// The marker that the extension was seen once.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
// Home folder for Chrome's host folders.
import { homedir } from "node:os";
// Folder of the running binary (release layout of sf), and paths.
import { dirname, join } from "node:path";
// Search and page reads by the upstream.
import {
	type ServerCall,
	type ServerStyle,
	type ServerWay,
	serverFetch,
	serverSearch,
} from "@earendil-works/pi-ai/api/server-search.lazy";
// Parameter schemas.
import { Type } from "typebox";
// Agent directory, binary detection, the extension folder.
import { getAgentDir, getWriterExtensionDir, isBunBinary } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// The bridge to Chrome.
import { bridgeAddress, bridgeCall } from "../../writer/browser/bridge.ts";
// Host registration and starting Chrome.
// Engine names.
import { ALL_ENGINES, type EngineName, parseEngines } from "../../writer/browser/engines.ts";
// web_fetch through Chrome.
import { browserFetch } from "../../writer/browser/fetch.ts";
import { ensureHost, startChrome } from "../../writer/browser/install.ts";
// Request pacing.
import { pace } from "../../writer/browser/pacing.ts";
// web_search through Chrome.
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
// Output messages.
import { currentLang, t } from "../../writer/i18n/index.ts";
// Secrets are taken out of upstream errors.
import { redactSecrets } from "../../writer/redact.ts";
// The AnySearch key held in memory.
import { withSecrets } from "../../writer/secrets.ts";
// The research archive.
import { ensureTopic } from "../../writer/topic/current.ts";
import { archiveFiltered, archivePage, archiveSearch } from "../../writer/topic/topic.ts";
// AnySearch backend.
import { anysearchExtract, anysearchSearch } from "../../writer/websearch/anysearch.ts";
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
// sf backend.
import { locateSf, parseSfFetch, runSf, sfChildEnv, sfError } from "../../writer/websearch/sf.ts";
// The configured model's name.
import { getWriterModel } from "../../writer/writer-model.ts";

/** How long to wait for Chrome to connect after starting it (ms). */
const CHROME_START_WAIT_MS = 20_000;
/** Shortest gap between two AnySearch requests (ms); several at once make it fail (the user, 2026-11-05). */
const ANYSEARCH_GAP_MS = 1000;

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
	const UPSTREAM_METHODS =
		"claude and codex = the upstream model does the work itself in a request of its own, with this conversation's model and effort: " +
		`claude is the way of Claude models, codex the way of Codex and GPT models, whatever the real upstream is.${configured} `;
	/** When the upstream methods apply. */
	const UPSTREAM_RULE =
		"Use claude or codex only when the user's prompt says the upstream supports it, and take the one of the configured model: claude for Claude models, codex for Codex and GPT models";
	// Which request style each upstream took in this session.
	const styles = new Map<string, ServerStyle>();

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
	function keep(ctx: ExtensionContext, write: (dir: string) => string): { dir?: string; note: string } {
		try {
			const dir = ensureTopic(ctx.cwd);
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
		};
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

	// web_search.
	pi.registerTool({
		// Name the model calls.
		name: "web_search",
		// Name shown in the interface.
		label: "Web search",
		// Full description sent to the model.
		description:
			"Search the web. method picks how: " +
			"browser = the user's Chrome through the JiaWriter extension, typing the query on each engine's home page as a person does and reading 3–5 results pages per engine, ranked locally; engines picks any of bing, google, baidu, sogou (default bing, google); about 1–2 minutes per engine, and an engine may ask for a human check. " +
			"anysearch = the AnySearch API: fast, needs no Chrome, results carry no dates. " +
			`${UPSTREAM_METHODS}` +
			"Returns titles, URLs, short snippets, dates when known and the search time. Keep the URL of every fact taken from them.",
		// One line in the tools section.
		promptSnippet: "Search the web for sources, recent news and facts; returns titles, URLs, snippets and dates",
		// Rules added while the tool is active.
		promptGuidelines: [
			// Whether to search at all is the user's call (the user, 2026-11-05).
			"Search only when the user's request calls for it: the user asks for research or recent facts, or for cases and data the reference materials do not hold. When the user asks to write, revise or polish from what is already there, work from that without searching, and never search when the user says not to",
			"Plan the searches for each question: pick the method and engines that fit it, and search again with a different query, engine or method when one result is not enough",
			"Name the method of every call yourself: none is the default. When a method is unavailable or fails, use another one or tell the user",
			UPSTREAM_RULE,
			"With claude and codex, only addresses in the results list go into the 参考文献 section, never one that appears only in the upstream's text",
			"Run searches and fetches one at a time: send a single web_search or web_fetch call in a message, read its result, then decide the next call",
			"When choosing what to fetch and cite, prefer reports from internationally renowned news organizations such as Reuters, AP, AFP, Bloomberg, BBC, The New York Times, The Wall Street Journal and the Financial Times",
			"Use baidu and sogou for mainland Chinese sources (sogou also finds WeChat public-account articles), bing and google for international and English sources, and anysearch for a quick first overview",
			"Write each query as 2–6 key terms: names of people, places, organisations, documents and specific terms, in place of a whole sentence or question",
			"Write Chinese queries for Chinese sources and English queries for international sources",
			"For recent events, take today's date from the latest [Sent …] time, put the year and month or the exact date into the query, set fresh to day, week or month, then use web_fetch on the authoritative outlet's page to read the full report",
			"Add site:domain to reach an official or authoritative site (site:gov.cn, site:xinhuanet.com, site:reuters.com), and put an exact name or title in quotation marks",
			"When results are few or off topic, rewrite the query with the official name, a synonym or a narrower term, or switch engine or method",
			"When a page still waits for a human check after the wait, tell the user which site it is and that the page stays open in Chrome, and fetch or search it again when the user says it is done",
			"Keep the source URL with every fact taken from search results for the 参考文献 section, and cite each case in the draft in the form 2026年10月31日《路透社》报道: work out from the address which outlet published the page and write its usual Chinese name, as 路透社 for reuters.com, never the address",
			"Treat a fact as current only when its page shows the date",
			"Read the whole result list before fetching and choose the pages yourself, judging each by its address and title: open reports from major international or national outlets and official sources that name a specific company, organisation or person or give authoritative data, and pass over forums, blogs, Q&A sites and reposts",
			"When the list has nothing of that kind, search again: in English with zone intl for international cases, with an outlet added to the query (路透社 or Reuters, site:reuters.com on the browser method), or with the official name of the company or body",
		],
		// Argument schema.
		parameters: Type.Object({
			query: Type.String({ description: "Search query: 2–6 key terms" }),
			method: Type.Union(
				[Type.Literal("browser"), Type.Literal("anysearch"), Type.Literal("claude"), Type.Literal("codex")],
				{
					description:
						"browser (Chrome, the engines below), anysearch (API), or claude or codex (the upstream model)",
				},
			),
			engines: Type.Optional(
				Type.Array(Type.Union(ALL_ENGINES.map((e) => Type.Literal(e))), {
					description:
						"browser method: engines in the order to use (bing, google, baidu, sogou; default bing, google)",
				}),
			),
			pages: Type.Optional(
				Type.Number({ description: "Results pages per engine, 3–5 (browser backend, default 3)" }),
			),
			fresh: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description: "Time window (browser method)",
				}),
			),
			zone: Type.Optional(
				Type.Union([Type.Literal("cn"), Type.Literal("intl")], { description: "Region (anysearch method)" }),
			),
			language: Type.Optional(Type.String({ description: "Preferred language, e.g. zh-CN or en" })),
		}),
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
			if (backend === "browser") {
				usedBrowser = true;
				// The previous results pages are closed first.
				for (const s of serps) await bridgeCall(address, "close", { tab: s.tab }, 10_000).catch(() => undefined);
				serps = [];
				// Bing, then Google.
				// The model's engines, else JW_ENGINES.
				const engines = params.engines?.length ? parseEngines(params.engines) : config.engines;
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
				const out = await serverSearch(await serverCall(ctx, backend, signal), params.query).catch((e: unknown) => {
					throw serverFailure(e);
				});
				raw = out.sources;
				answer = out.text;
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
			const kept = keep(ctx, (dir) => archiveSearch(dir, params.query, report, nowText(), urls));
			const text = [t("search.time", { time: nowText() }), ...notes, report, kept.note].filter(Boolean).join("\n");
			// Text and structured results.
			return { content: [{ type: "text", text }], details: { backend, results, topicDir: kept.dir } };
		},
	});

	// web_fetch.
	pi.registerTool({
		// Name the model calls.
		name: "web_fetch",
		// Name shown in the interface.
		label: "Web fetch",
		// Full description sent to the model.
		description:
			"Fetch one web page and return its main text. method picks how: " +
			"browser = open it in the user's Chrome (clicked on the last results page when it is there), for news sites and pages that need a real browser; " +
			"anysearch = the AnySearch extract API, fast; " +
			"sf = search_fetch, for documents (PDF, Word, Excel links, parsed to text) and video pages (metadata). " +
			UPSTREAM_METHODS.trim(),
		// One line in the tools section.
		promptSnippet: "Fetch a web page and read its main text, title, source and date",
		// Rules added while the tool is active.
		promptGuidelines: [
			"Use method sf for links to PDF, Word or Excel documents and for video pages, and browser for news and official pages",
			"When a fetch fails or returns little text, fetch the page again with another method",
			"Name the method of every call yourself: none is the default",
			UPSTREAM_RULE,
			"Method claude reads the page as served: pages built by JavaScript, addresses over 250 characters and sites closed to crawlers need browser",
		],
		// Argument schema.
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL of the page" }),
			method: Type.Union(
				[
					Type.Literal("browser"),
					Type.Literal("anysearch"),
					Type.Literal("sf"),
					Type.Literal("claude"),
					Type.Literal("codex"),
				],
				{
					description:
						"browser (Chrome), anysearch (API), sf (documents and video pages), or claude or codex (the upstream model)",
				},
			),
		}),
		// Read-only, open world.
		annotations: WEB,
		// One at a time, like web_search.
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
			if (backend === "browser") {
				usedBrowser = true;
				page = await browserFetch(deps(ctx, signal), params.url, serps, timing);
			} else if (backend === "sf") {
				// sf fetch in the working folder (the URL after the separator).
				const sf = sfContext(ctx.hasUI);
				const runOut = await runSf(sf.bin, ["fetch", "--json", "--", params.url], {
					cwd: ctx.cwd,
					env: sf.env,
					timeoutMs: config.timeoutMs,
					signal,
				});
				if (runOut.code !== 0) throw sfError(runOut, config.timeoutMs);
				page = parseSfFetch(runOut.stdout, params.url);
			} else if (isServerWay(backend)) {
				// The upstream reads it.
				const out = await serverFetch(await serverCall(ctx, backend, signal), params.url).catch((e: unknown) => {
					throw serverFailure(e);
				});
				page = { url: out.url || params.url, title: out.title, content: out.content, date: "" };
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
			const kept = keep(ctx, (dir) => {
				const file = archivePage(dir, page, params.url, backend, nowText());
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
			const text = [formatFetch(page, backend), unsure, kept.note, left].filter(Boolean).join("\n");
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
