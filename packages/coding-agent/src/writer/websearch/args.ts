/**
 * Tool arguments as models really send them: optional fields filled with null or an empty value, engines given
 * to a method without engines, names in another case or form. Each call keeps what its method can use, in the
 * shape the schema wants; what cannot be used is dropped, so a slip never costs a failed call.
 */

// The engine names.
import { ALL_ENGINES } from "../browser/engines.ts";

/** The parameters each search_web method takes, besides query and method. */
const SEARCH_PARAMS: Readonly<Record<string, readonly string[]>> = {
	browser: ["engines", "pages", "fresh"],
	anysearch: ["zone", "language"],
	claude: [],
	codex: ["fresh"],
};

/** Time windows of the browser and codex methods. */
const WINDOWS = ["day", "week", "month", "year"];
/** Regions of the anysearch method. */
const ZONES = ["cn", "intl"];
/** Other names of the engines. */
const ENGINE_NAMES: Readonly<Record<string, string>> = { 必应: "bing", 谷歌: "google", 百度: "baidu", 搜狗: "sogou" };

/** Every option of search_web. */
const OPTION_NAMES = ["engines", "pages", "fresh", "zone", "language"];

/** True when a field really holds a value. */
function filled(value: unknown): boolean {
	// null, "" and [] are what strict models send for a field they leave out.
	return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/** The arguments as they took effect, for showing a call: what the method does not use stays out. */
export function shownSearchArgs(args: unknown): Record<string, unknown> {
	// The record of what was dropped is no argument.
	const { ignored: _ignored, ...shown } = cleanSearchArgs(args);
	return shown;
}

/** A raw call as an object. */
function record(raw: unknown): Record<string, unknown> {
	// Anything else has nothing to clean.
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** One word in the form the schema uses. */
function word(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** An engine's name from any common way of writing it, or "" when it is none. */
function engineName(value: unknown): string {
	// Bare name: no scheme, no www, no domain ending.
	const name = word(value)
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\.[a-z.]+\/?$/, "");
	const known = ENGINE_NAMES[name] ?? name;
	return (ALL_ENGINES as readonly string[]).includes(known) ? known : "";
}

/** The engines asked for, each once; a list or a string with commas or spaces. */
function engineList(value: unknown): string[] {
	// One string may name several.
	const items = typeof value === "string" ? value.split(/[,，、\s]+/) : Array.isArray(value) ? value : [];
	return [...new Set(items.map(engineName).filter(Boolean))];
}

/** search_web arguments that hold only what the method can use. */
export function cleanSearchArgs(raw: unknown): Record<string, unknown> {
	const args = record(raw);
	// A list of words is still a query.
	const query = Array.isArray(args.query) ? args.query.join(" ") : args.query;
	// An engine named as the method means the browser on that engine.
	const named = engineName(args.method);
	const method = named ? "browser" : word(args.method);
	const out: Record<string, unknown> = { query };
	// An unknown method stays: the schema names the valid ones.
	if (method) out.method = method;
	else if (args.method !== undefined && args.method !== null) out.method = args.method;
	// Only the parameters of this method.
	const allowed = SEARCH_PARAMS[method] ?? [];
	if (allowed.includes("engines")) {
		const engines = engineList(named ? [named, ...engineList(args.engines)] : args.engines);
		if (engines.length > 0) out.engines = engines;
	}
	if (allowed.includes("pages")) {
		const pages = Number(args.pages);
		if (args.pages !== null && args.pages !== "" && Number.isFinite(pages)) out.pages = pages;
	}
	if (allowed.includes("fresh") && WINDOWS.includes(word(args.fresh))) out.fresh = word(args.fresh);
	if (allowed.includes("zone") && ZONES.includes(word(args.zone))) out.zone = word(args.zone);
	if (allowed.includes("language") && typeof args.language === "string" && args.language.trim())
		out.language = args.language.trim();
	// What the model asked for and this method does not use, so the result can say so.
	const ignored = OPTION_NAMES.filter((name) => filled(args[name]) && !allowed.includes(name));
	if (SEARCH_PARAMS[method] && ignored.length > 0) out.ignored = ignored;
	return out;
}

/** fetch_web arguments: the address as given, the method in the form the schema uses, codex's own options. */
export function cleanFetchArgs(raw: unknown): Record<string, unknown> {
	const args = record(raw);
	// The address is never touched.
	const out: Record<string, unknown> = { url: args.url };
	const method = word(args.method);
	if (method) out.method = method;
	else if (args.method !== undefined && args.method !== null) out.method = args.method;
	// Only codex can start at a line or look for words; 0 is the page's start and needs no field.
	if (method !== "codex") return out;
	const lineno = Number(args.lineno);
	if (Number.isInteger(lineno) && lineno > 0) out.lineno = lineno;
	if (typeof args.find === "string" && args.find.trim()) out.find = args.find.trim();
	return out;
}
