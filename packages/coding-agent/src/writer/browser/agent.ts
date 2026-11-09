/**
 * The agent's `browser` tool: one action on a tab of the dedicated window, through the protocol in writer/protocol.ts.
 * Permission, stale references and limits are decided here, by rules; what comes back says who goes on.
 */

// The shape of every result.
import { holdSite } from "../held-sites.ts";
// Too few words to count as a reading.
import { MIN_WORDS } from "../ocr.ts";
// What the permission gate answers.
import {
	isSecretField,
	type PermissionRefusal,
	type PermissionRequest,
	type Risk,
	riskOfLabel,
} from "../permission.ts";
import { type Breaker, type Outcome, outcome } from "../protocol.ts";
// Images, as a last resort.
import { type Capture, type ImageLedger, type ImageSupport, pagePoint, pictureHash } from "../vision.ts";
// The extension is not there.
import { BridgeUnavailable } from "./bridge.ts";
// A wall in front of the page.
import { type Probe, pageVerdict } from "./fetch.ts";

/** What the tool can do. */
export const BROWSER_ACTIONS = [
	"open",
	"read",
	"find",
	"click",
	"hover",
	"type",
	"select",
	"key",
	"scroll",
	"drag",
	"upload",
	"wait",
	"back",
	"tabs",
	"dialog",
	"eval",
	"look",
	"point",
] as const;

/** One of the actions. */
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** The model's request. */
export interface BrowserInput {
	action: BrowserAction;
	url?: string;
	ref?: string;
	to?: string;
	text?: string;
	query?: string;
	key?: string;
	option?: string;
	code?: string;
	files?: string[];
	dy?: number;
	seconds?: number;
	clear?: boolean;
	enter?: boolean;
	all?: boolean;
	main?: boolean;
	accept?: boolean;
	reason?: string;
	x?: number;
	y?: number;
	capture?: string;
}

/** What one session keeps. */
export interface BrowserState {
	// The tab in use.
	tab?: number;
	// Its address.
	url: string;
	// Reference → label, from the last read.
	labels: Map<string, string>;
	// Reference → role (combobox, textbox, button) from the same read.
	roles?: Map<string, string>;
	// Sites waiting for the user, such as a verification page.
	held: Set<string>;
	// A page dialog is open: nothing else in the tab can happen until it is answered.
	dialog: boolean;
	// The address last read: looking comes after reading.
	readUrl: string;
	// Pictures already tried on this machine: the next step for one is the upstream.
	ocrTried: Set<string>;
	// The last picture, for a point in it.
	capture?: Capture;
}

/** What looking needs from outside. */
export interface BrowserVision {
	// Longest edge of a picture.
	edge: number;
	ledger: ImageLedger;
	// Words in a picture, read on this machine.
	ocr(data: string): Promise<string>;
	// Whether the upstream takes images; may spend a tiny request, so it comes after the user agreed.
	supported(): Promise<ImageSupport>;
}

/** What the tool needs from outside. */
export interface BrowserDeps {
	// One operation of the extension.
	call(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
	// Whether an action may go on.
	permit(request: PermissionRequest): Promise<PermissionRefusal>;
	// Failures per target.
	breaker: Breaker;
	state: BrowserState;
	// Marks the tabs of this session.
	run: string;
	// Waits, replaced in tests.
	sleep(ms: number): Promise<void>;
	// The question for an action, from the interface language.
	ask(action: string, scope: string): string;
	vision: BrowserVision;
}

/** Longest wait the model may ask for (s). */
const MAX_WAIT_S = 15;
/** Most candidates find gives back. */
const MAX_FOUND = 20;
/** Load wait of an action (ms). */
const LOAD_MS = 10_000;
/** Time an operation may take (ms). */
const CALL_MS = 40_000;

/** A session with nothing open. */
export function newBrowserState(): BrowserState {
	return { url: "", labels: new Map(), held: new Set(), dialog: false, readUrl: "", ocrTried: new Set() };
}

/** The site of an address ("" when it has none). */
export function siteOf(url: string): string {
	return URL.canParse(url) ? new URL(url).hostname : "";
}

/** Reference → label from the lines of a read, such as `[e3] button "提交"`. */
export function labelsOf(lines: string): Map<string, string> {
	return new Map([...lines.matchAll(/^\[(e\d+)\] \S+(?: "([^"]*)")?/gm)].map((m) => [m[1], m[2] ?? ""]));
}

/** Reference → role from the lines of a read, such as `[e1] combobox = "2023"`. */
export function rolesOf(lines: string): Map<string, string> {
	return new Map([...lines.matchAll(/^\[(e\d+)\] (\S+)/gm)].map((m) => [m[1], m[2]]));
}

/** The roles an action without a reference may mean: a choice is made in a list, text goes in a field. */
const REF_ROLES: Readonly<Record<string, readonly string[]>> = {
	select: ["combobox", "listbox"],
	type: ["textbox", "searchbox", "textarea"],
};

/**
 * The elements an action without a reference may mean, by role (2026-11-09: a run sent select with the option and no
 * reference five times, naming e1 only in its reason). One of them is the element; none or several leave it open.
 */
export function refCandidates(action: string, roles: ReadonlyMap<string, string> | undefined): string[] {
	const wanted = REF_ROLES[action];
	if (!wanted || !roles) return [];
	return [...roles].filter(([, role]) => wanted.includes(role)).map(([ref]) => ref);
}

/** The lines that hold the words looked for; empty words give none. */
export function matchLines(lines: string, query: string): string[] {
	const words = query.trim().toLowerCase();
	return words
		? lines
				.split("\n")
				.filter((line) => line.toLowerCase().includes(words))
				.slice(0, MAX_FOUND)
		: [];
}

/** How much an action can do; a click depends on what it presses. */
export function riskOf(input: BrowserInput, label: string): Risk {
	if (["eval", "upload", "look", "point"].includes(input.action)) return "high";
	// Accepting can confirm anything a page asks.
	if (input.action === "dialog") return input.accept ? "high" : "act";
	if (input.action === "click") return riskOfLabel(label);
	if (["type", "select", "key", "drag"].includes(input.action)) return "act";
	return "read";
}

/** The operation an action on the tab maps to, with its arguments. */
export function pageOp(input: BrowserInput): [string, Record<string, unknown>] {
	const { ref, to, text, clear, enter, option, key, dy, files, accept } = input;
	switch (input.action) {
		case "click":
			return ["page_click", { ref }];
		case "hover":
			return ["page_hover", { ref }];
		case "type":
			return ["page_type", { ref, text, clear, enter }];
		case "select":
			return ["page_select", { ref, option }];
		case "key":
			return ["page_key", { key }];
		case "scroll":
			return ["page_scroll", { ref, dy }];
		case "drag":
			return ["page_drag", { ref, to }];
		case "upload":
			return ["page_upload", { ref, files }];
		case "dialog":
			return ["page_dialog", { accept, text }];
		default:
			return ["info", {}];
	}
}

/** The fields of what an action on the tab gave back. */
export interface PageReply {
	url?: string;
	title?: string;
	tab?: number;
	route?: string;
	changed?: boolean;
	holds?: boolean;
	newTab?: number | null;
	dialog?: { type: string; message: string } | null;
	missing?: boolean;
	hidden?: boolean;
	refused?: boolean;
	reason?: string;
	role?: string;
	name?: string;
	moved?: boolean;
}

/** True when a page is a verification wall, which the user has to pass. */
export async function walled(deps: BrowserDeps, tab: number): Promise<boolean> {
	try {
		// In the page's own world, as the fetch flow reads it.
		const raw = await deps.call("run", { tab, script: "probe", world: "MAIN" }, CALL_MS);
		return pageVerdict(JSON.parse(String(raw)) as Probe) === "challenge";
	} catch {
		// No answer is no wall: the read below reports what is there.
		return false;
	}
}

/** Read the tab and remember its references. */
export async function readTab(deps: BrowserDeps, input: BrowserInput): Promise<Outcome> {
	const { state } = deps;
	const tab = state.tab as number;
	if (await walled(deps, tab)) {
		state.held.add(siteOf(state.url));
		// No other tool reaches the site either, until the user has passed it.
		holdSite(siteOf(state.url));
		return outcome("refused", "read", "user", "verification", { url: state.url });
	}
	const page = (await deps.call("page_read", { tab, text: input.all ?? false }, CALL_MS)) as {
		url: string;
		title: string;
		lines: string;
		truncated: boolean;
		kind: string;
		dialog?: unknown;
	};
	state.url = page.url;
	state.readUrl = page.url;
	state.labels = labelsOf(page.lines);
	state.roles = rolesOf(page.lines);
	const found = input.action === "find" ? matchLines(page.lines, input.query ?? "") : [];
	const lines = input.action === "find" ? found.join("\n") : page.lines;
	const data = {
		url: page.url,
		title: page.title,
		truncated: page.truncated,
		lines,
		dialog: page.dialog ?? undefined,
	};
	// Nothing readable: the next step is the program's, not a guess by the model.
	if (page.kind !== "page") return outcome("unverifiable", "read", "user", `no-tree:${page.kind}`, data);
	return outcome("confirmed", "read", "model", "", data);
}

/** What an action on the tab came to. */
export function pageOutcome(input: BrowserInput, reply: PageReply, key: string, breaker: Breaker): Outcome {
	const route = reply.route ?? input.action;
	const data = {
		url: reply.url,
		title: reply.title,
		dialog: reply.dialog ?? undefined,
		moved: reply.moved || undefined,
	};
	// The target is not there, or will not take this.
	if (reply.missing || reply.refused) {
		const reason = reply.reason ?? (reply.hidden ? "hidden" : "stale-ref");
		// Bringing the window forward is the user's to do; anything else the model may try once more.
		const stopped = breaker.failed(key) || reason === "needs-front";
		return outcome(reply.refused ? "refused" : "failed", route, stopped ? "user" : "model", reason, {
			role: reply.role,
			name: reply.name,
		});
	}
	breaker.passed(key);
	// A dialog holds the page until someone answers it.
	if (reply.dialog) return outcome("unverifiable", route, "model", "dialog", data);
	if (input.action === "type" && !reply.holds) return outcome("unverifiable", route, "model", "not-in-field", data);
	if (reply.changed || reply.holds) return outcome("confirmed", route, "model", "", data);
	// The program has compared the page already; only the model can say what that means.
	return outcome("unverifiable", route, "model", "no-change", data);
}

/** Wait for words to appear, or for a time. */
export async function waitOn(deps: BrowserDeps, input: BrowserInput): Promise<Outcome> {
	const seconds = Math.min(Math.max(input.seconds ?? 2, 0), MAX_WAIT_S);
	if (!input.text) {
		await deps.sleep(seconds * 1000);
		return outcome("confirmed", "wait", "model");
	}
	for (let waited = 0; waited <= seconds; waited++) {
		const page = (await deps.call("page_read", { tab: deps.state.tab, text: true }, CALL_MS)) as { lines: string };
		if (page.lines.includes(input.text)) return outcome("confirmed", "wait", "model");
		await deps.sleep(1000);
	}
	return outcome("unverifiable", "wait", "model", "not-seen");
}

/** Run code in the page once. */
export async function evalIn(deps: BrowserDeps, input: BrowserInput): Promise<Outcome> {
	const reply = (await deps.call(
		"page_eval",
		{ tab: deps.state.tab, code: input.code, main: input.main ?? false },
		CALL_MS,
	)) as { value?: string; error?: string; truncated?: boolean };
	if (reply.error) return outcome("failed", "eval", "model", "script-error", { error: reply.error });
	return outcome("confirmed", "eval", "model", "", { value: reply.value, truncated: reply.truncated });
}

/** The answer a capture gives. */
interface CaptureReply {
	data?: string;
	mimeType?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
	url: string;
	missing?: boolean;
}

/** Take the picture, on this machine; nothing has left it yet. */
export async function capturePage(deps: BrowserDeps, input: BrowserInput): Promise<CaptureReply> {
	const { state, vision } = deps;
	const args = { tab: state.tab, ref: input.ref, edge: vision.edge };
	return (await deps.call("page_capture", args, CALL_MS)) as CaptureReply;
}

/** What a picture needs to go anywhere. */
export interface LookDeps {
	vision: BrowserVision;
	permit(request: PermissionRequest): Promise<PermissionRefusal>;
	ask(action: string, scope: string): string;
	state: { ocrTried: Set<string> };
}

/** A picture on this machine: words read here first, the upstream only when those were not enough and the user agrees. */
export async function sendOrRead(
	deps: LookDeps,
	shot: { data: string; mimeType: string; scope: string; reason?: string; size: string },
	part: boolean,
): Promise<Outcome> {
	const { state, vision } = deps;
	const hash = pictureHash(shot.data);
	// The picture is with the model already, so there is nothing new to see.
	if (vision.ledger.seen(hash)) return outcome("confirmed", "look", "model", "unchanged");
	// Words read here cost nothing; a second look at the same picture means they were not enough.
	if (!state.ocrTried.has(hash)) {
		state.ocrTried.add(hash);
		const words = await vision.ocr(shot.data);
		if (words.length >= MIN_WORDS) return outcome("confirmed", "ocr", "model", "", { lines: words });
	}
	const over = vision.ledger.refusal();
	if (over) return outcome("refused", "look", "user", over);
	const refusal = await deps.permit({
		risk: "high",
		scope: shot.scope,
		title: deps.ask("look", shot.scope),
		detail: `${shot.size}\n${shot.reason ?? ""}`,
	});
	if (refusal) return outcome("refused", "look", "user", refusal);
	if ((await vision.supported()) !== true) return outcome("refused", "look", "user", "no-image-input");
	vision.ledger.spend(hash);
	// A whole view is for finding one's way; a part is for reading.
	const picture = { data: shot.data, mimeType: shot.mimeType, detail: part ? "auto" : "low" };
	return outcome("confirmed", "look", "model", "", { size: shot.size, picture });
}

/** Look at the page: what is on this machine first, the upstream only when that was not enough. */
export async function lookAt(input: BrowserInput, deps: BrowserDeps): Promise<Outcome> {
	const { state } = deps;
	const scope = siteOf(state.url);
	if (!input.reason) return outcome("refused", "look", "model", "reason-required");
	if (state.readUrl !== state.url) return outcome("refused", "look", "model", "read-first");
	const shot = await capturePage(deps, input);
	if (shot.missing || !shot.data) return outcome("failed", "look", "model", "stale-ref");
	const result = await sendOrRead(
		deps,
		{
			data: shot.data,
			mimeType: shot.mimeType ?? "image/jpeg",
			scope,
			reason: input.reason,
			size: `${Math.round(shot.width * shot.scale)}×${Math.round(shot.height * shot.scale)}`,
		},
		Boolean(input.ref),
	);
	if (result.route === "look" && result.data?.picture) {
		const hash = pictureHash(shot.data);
		state.capture = {
			id: hash.slice(0, 8),
			url: shot.url,
			scale: shot.scale,
			x: shot.x,
			y: shot.y,
			width: shot.width,
			height: shot.height,
		};
		result.data.capture = state.capture.id;
	}
	return result;
}

/** Act on a point of the last picture, while it still shows the page. */
export async function pointAt(input: BrowserInput, deps: BrowserDeps): Promise<Outcome> {
	const { state } = deps;
	const capture = state.capture;
	if (!capture || capture.id !== input.capture || capture.url !== state.url)
		return outcome("refused", "point", "model", "capture-stale");
	const at = pagePoint(capture, input.x ?? -1, input.y ?? -1);
	if (!at) return outcome("refused", "point", "model", "outside-capture");
	const refusal = await deps.permit({
		risk: "high",
		scope: siteOf(state.url),
		title: deps.ask("point", siteOf(state.url)),
		detail: `${Math.round(at.x)}, ${Math.round(at.y)}`,
	});
	if (refusal) return outcome("refused", "point", "user", refusal);
	const reply = (await deps.call(
		"page_point",
		{ tab: state.tab, ...at, load_ms: LOAD_MS, run: deps.run },
		CALL_MS,
	)) as PageReply;
	// The page moved on: this picture says nothing about it any more.
	state.capture = undefined;
	if (reply.url) state.url = reply.url;
	state.dialog = !!reply.dialog;
	return pageOutcome(input, reply, `point\n${capture.id}`, deps.breaker);
}

/** One action, whatever comes of it. */
/** Actions that act on one control and need its reference. */
const REF_ACTIONS: ReadonlySet<string> = new Set(["click", "hover", "type", "select", "drag", "upload"]);

/**
 * The input as the model meant it (2026-11-09, a form a real run never filled): a reference copied with its brackets
 * ([e1]) is the reference, and a click that carries text to enter is typing.
 */
export function normalizeBrowserInput(input: BrowserInput): BrowserInput {
	const ref = input.ref?.trim().replace(/^\[(.+)\]$/, "$1") || undefined;
	const action = input.action === "click" && input.text?.trim() ? "type" : input.action;
	return { ...input, action, ref };
}

export async function runBrowser(given: BrowserInput, deps: BrowserDeps): Promise<Outcome> {
	const input = normalizeBrowserInput(given);
	const { state, breaker } = deps;
	const { action } = input;
	const key = `${action}\n${state.url}\n${input.ref ?? input.url ?? ""}`;
	try {
		// The same target failed: the program stops here, and the user hears it.
		if (!breaker.allows(key)) return outcome("refused", action, "user", "tried-twice");
		if (action === "tabs") {
			const list = (await deps.call("page_tabs", { run: deps.run }, CALL_MS)) as Record<string, unknown>;
			return outcome("confirmed", "tabs", "model", "", list);
		}
		const scope = siteOf(input.url ?? state.url);
		if (state.held.has(scope)) return outcome("refused", action, "user", "held-for-user", { site: scope });
		if (action !== "open" && state.tab === undefined) return outcome("refused", action, "model", "no-page");
		if (state.dialog && action !== "dialog") return outcome("refused", action, "model", "dialog-open");
		// No reference to act on: the only list or field of the page when there is one; else said as such, with the
		// elements it may be, not as a page that changed (a run sent x and y instead 38 times).
		if (REF_ACTIONS.has(action) && !input.ref) {
			const candidates = refCandidates(action, state.roles);
			// Only with what to put there: an empty type once sent a search form off blank (2026-11-09).
			const content = action === "select" ? input.option?.trim() : action === "type" ? input.text?.trim() : "";
			if (candidates.length === 1 && content) input.ref = candidates[0];
			else
				return outcome("failed", action, "model", "no-ref", { need: "ref: an [eN] of the last read", candidates });
		}
		// Each of these goes through its own steps.
		if (action === "look") return await lookAt(input, deps);
		if (action === "point") return await pointAt(input, deps);
		// A password never goes through here.
		if (action === "type") {
			const field = (await deps.call("page_field", { tab: state.tab, ref: input.ref }, CALL_MS)) as {
				type?: string;
				role?: string;
			};
			if (isSecretField(field.role ?? "", field.type ?? ""))
				return outcome("refused", "type", "user", "password-field");
		}
		const label = state.labels.get(input.ref ?? "") ?? "";
		const detail =
			action === "eval" ? (input.code ?? "") : action === "upload" ? (input.files ?? []).join("\n") : label;
		const refusal = await deps.permit({
			risk: riskOf(input, label),
			scope,
			title: deps.ask(action, scope),
			detail,
		});
		if (refusal) return outcome("refused", action, "user", refusal);
		if (action === "open") {
			const opened = (await deps.call(
				"open",
				{ url: input.url, run: deps.run, load_ms: LOAD_MS },
				CALL_MS,
			)) as PageReply;
			state.tab = opened.tab;
			state.url = opened.url ?? input.url ?? "";
			state.labels.clear();
			state.roles?.clear();
			return readTab(deps, { ...input, action: "read" });
		}
		if (action === "back") {
			const went = (await deps.call("back", { tab: state.tab, load_ms: LOAD_MS }, CALL_MS)) as PageReply;
			state.url = went.url ?? state.url;
			return readTab(deps, { ...input, action: "read" });
		}
		if (action === "read" || action === "find") return await readTab(deps, input);
		if (action === "wait") return await waitOn(deps, input);
		if (action === "eval") return await evalIn(deps, input);
		const [op, args] = pageOp(input);
		const reply = (await deps.call(
			op,
			{ tab: state.tab, ...args, load_ms: LOAD_MS, run: deps.run },
			CALL_MS,
		)) as PageReply;
		if (reply.newTab) state.tab = reply.newTab;
		// Another address: the references read on the old page are no longer the page's.
		if (reply.newTab || (reply.url && reply.url !== state.url)) {
			state.labels.clear();
			state.roles?.clear();
		}
		if (reply.url) state.url = reply.url;
		state.dialog = !!reply.dialog;
		return pageOutcome(input, reply, key, breaker);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The program shows the steps; the model has nothing to do here.
		if (error instanceof BridgeUnavailable) return outcome("failed", action, "user", "not-connected");
		// An older extension does not know this: reloading it is the user's step.
		if (/unknown op/.test(message)) return outcome("failed", action, "user", "extension-old");
		// The element of a reference is no longer in the page (it reloaded or moved): read it again.
		if (
			/does not belong to the document|No node with given id|Either objectId or executionContextId|Could not find node/.test(
				message,
			)
		)
			return outcome("failed", action, breaker.failed(key) ? "user" : "model", "stale-ref", {
				need: "read the page again for new references",
			});
		// The tab was closed under the session.
		if (/not a JiaWriter tab|No tab with id/.test(message)) {
			state.tab = undefined;
			return outcome("failed", action, "model", "tab-gone");
		}
		return outcome("failed", action, breaker.failed(key) ? "user" : "model", "error", { message });
	}
}
