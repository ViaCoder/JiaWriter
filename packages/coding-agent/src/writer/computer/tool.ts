/**
 * The agent's `computer` tool: a fixed set of actions on one window, through the protocol in writer/protocol.ts. The
 * driver has many more tools; the model reaches only these. Delivery stays in the background: a refusal from the
 * driver goes to the user, and the program never takes the foreground on its own.
 */

// Looking, as on a page.
import { type LookDeps, sendOrRead } from "../browser/agent.ts";
// Questions to the user.
import { isSecretField, type PermissionRefusal, type PermissionRequest, riskOfLabel } from "../permission.ts";
// The shape of every result.
import { type Breaker, type Outcome, outcome } from "../protocol.ts";
// The driver.
import type { DriverClient, DriverReply } from "./client.ts";

/** What the tool can do. */
export const COMPUTER_ACTIONS = ["windows", "launch", "read", "click", "type", "key", "scroll", "look"] as const;

/** One of the actions. */
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** How far an application may be acted on: browsers by the browser tool, terminals by shell tools. */
export type AppTier = "full" | "read" | "click";

/** The model's request. */
export interface ComputerInput {
	action: ComputerAction;
	pid?: number;
	window?: number;
	name?: string;
	ref?: string;
	text?: string;
	key?: string;
	direction?: string;
	amount?: number;
	reason?: string;
}

/** What one session keeps. */
export interface ComputerState {
	pid?: number;
	window?: number;
	// The window's name, which is what permission is asked for.
	app: string;
	// The driver's name for the last read: the model says rows, the program makes them tokens.
	snapshot: string;
	// Row → role and name, from the last read.
	labels: Map<string, { role: string; name: string }>;
	ocrTried: Set<string>;
}

/** What the tool needs from outside. */
export interface ComputerDeps extends LookDeps {
	driver(): Promise<DriverClient | undefined>;
	permit(request: PermissionRequest): Promise<PermissionRefusal>;
	breaker: Breaker;
	state: ComputerState;
	ask(action: string, scope: string): string;
}

/** The driver's word for a token from an older read. */
const STALE_TOKEN = "stale_element_token";
/** Most characters of a tree. */
const MAX_TREE = 12_000;
/** Most elements read. */
const MAX_ELEMENTS = 400;
/** Applications driven through their own tools. */
const BROWSERS = /chrome|chromium|firefox|safari|edge|brave|opera|arc\b|浏览器/i;
const TERMINALS =
	/terminal|iterm|konsole|alacritty|kitty|wezterm|powershell|cmd\.exe|visual studio code|\bvs ?code\b|jetbrains|intellij|pycharm|终端/i;

/** A session with nothing chosen. */
export function newComputerState(): ComputerState {
	return { app: "", snapshot: "", labels: new Map(), ocrTried: new Set() };
}

/** How far this application may be acted on. */
export function appTier(name: string): AppTier {
	if (BROWSERS.test(name)) return "read";
	return TERMINALS.test(name) ? "click" : "full";
}

/** Row → role and name, from a tree's lines such as `- [2] push button "确定"`. */
export function treeLabels(tree: string): Map<string, { role: string; name: string }> {
	const rows = [...tree.matchAll(/^\s*- \[(\d+)\] ([^"\n[]+?)(?: "([^"]*)")?(?: value=| \[|$)/gm)];
	return new Map(rows.map((m) => [m[1], { role: m[2].trim(), name: m[3] ?? "" }]));
}

/** The driver's token for a row of the last read. */
export function tokenOf(state: ComputerState, row: string | undefined): string {
	return `${state.snapshot}:${row ?? ""}`;
}

/** The one row with this role and name, or undefined when there are none or several. */
export function sameRow(state: ComputerState, label: { role: string; name: string } | undefined): string | undefined {
	if (!label) return undefined;
	const rows = [...state.labels].filter(([, l]) => l.role === label.role && l.name === label.name);
	return rows.length === 1 ? rows[0][0] : undefined;
}

/** True for text only the driver's value route writes whole: typing it key by key loses characters. */
export function needsValueRoute(text: string): boolean {
	return [...text].some((ch) => ch.charCodeAt(0) > 0x7f);
}

/** What the driver's answer comes to. */
export function replyOutcome(action: string, reply: DriverReply): Outcome {
	const { structured } = reply;
	const route = String(structured.route ?? action);
	const refusal = structured.refusal as { code?: string } | undefined;
	// The driver refused rather than take over: that is for the user, never for a retry.
	if (refusal?.code) return outcome("refused", route, "user", refusal.code);
	if (reply.failed)
		return outcome("failed", route, "model", String(structured.code ?? "error"), {
			message: reply.text.slice(0, 300),
		});
	if (structured.effect === "confirmed") return outcome("confirmed", route, "model");
	return outcome("unverifiable", route, "model", "no-change");
}

/** Read the window, keeping the references; `since` asks for changes only, which is far shorter. */
export async function readWindow(driver: DriverClient, deps: ComputerDeps, since?: string): Promise<Outcome> {
	const { state } = deps;
	const reply = await driver.call("get_window_state", {
		pid: state.pid,
		window_id: state.window,
		include_screenshot: false,
		max_elements: MAX_ELEMENTS,
		...(since ? { since } : {}),
	});
	if (reply.failed) return replyOutcome("read", reply);
	const tree = String(reply.structured.tree_markdown ?? reply.text);
	state.snapshot = String(reply.structured.snapshot_id ?? state.snapshot);
	if (!since) state.labels = treeLabels(tree);
	const title = /frame = "([^"]*)"/.exec(tree)?.[1];
	if (title) state.app = title;
	if (Number(reply.structured.element_count ?? 1) === 0) return outcome("unverifiable", "read", "user", "no-tree");
	return outcome("confirmed", "read", "model", "", {
		lines: tree.slice(0, MAX_TREE),
		truncated: tree.length > MAX_TREE,
		diff: reply.structured.diff_counts,
	});
}

/** Reads of the window after an action that the driver could not confirm, and the pause between them (ms). */
export const SETTLE_READS = 3;
const SETTLE_PAUSE_MS = 250;

/** After an action the driver could not confirm: a few reads of what changed, then it is the model's to judge. */
export async function settled(
	driver: DriverClient,
	deps: ComputerDeps,
	action: string,
	reply: DriverReply,
): Promise<Outcome> {
	const result = replyOutcome(action, reply);
	if (result.effect !== "unverifiable") return result;
	// UI Automation shows a new value a moment later, so the window is read a few times; each read is compared
	// with the one before it, so a change between two reads is seen too.
	for (let attempt = 0; attempt < SETTLE_READS; attempt++) {
		if (attempt > 0) await new Promise((done) => setTimeout(done, SETTLE_PAUSE_MS));
		const after = await driver.call("get_window_state", {
			pid: deps.state.pid,
			window_id: deps.state.window,
			include_screenshot: false,
			since: "latest",
		});
		// A new read retires the old tokens.
		deps.state.snapshot = String(after.structured.snapshot_id ?? deps.state.snapshot);
		const diff = after.structured.diff_counts as { added?: number; changed?: number; removed?: number } | undefined;
		if ((diff?.added ?? 0) + (diff?.changed ?? 0) + (diff?.removed ?? 0) > 0)
			return outcome("confirmed", result.route, "model");
	}
	return result;
}

/** Put text into a field: by value when it can, since keys lose anything but ASCII. */
export async function typeInto(driver: DriverClient, deps: ComputerDeps, input: ComputerInput): Promise<Outcome> {
	const { state } = deps;
	const target = { pid: state.pid, window_id: state.window, element_token: tokenOf(state, input.ref) };
	const set = await driver.call("set_value", { ...target, value: input.text ?? "" });
	if (set.structured.refusal) return replyOutcome("type", set);
	if (!set.failed) return settled(driver, deps, "type", set);
	if (needsValueRoute(input.text ?? "")) return outcome("refused", "type", "user", "cannot-type-text");
	return settled(driver, deps, "type", await driver.call("type_text", { ...target, text: input.text ?? "" }));
}

/** List the windows there are, with nothing of the hundreds of background processes. */
export async function listWindows(driver: DriverClient): Promise<Outcome> {
	const reply = await driver.call("list_windows", { on_screen_only: true });
	if (reply.failed) return replyOutcome("windows", reply);
	const windows = (reply.structured.windows ?? []) as Record<string, unknown>[];
	return outcome("confirmed", "windows", "model", "", {
		windows: windows.map((w) => ({ pid: w.pid, window: w.window_id, app: w.app_name ?? w.app, title: w.title })),
	});
}

/** The permission an action needs, and whether the application's tier lets it through. */
export function tierRefusal(input: ComputerInput, tier: AppTier): string {
	if (tier === "read" && ["click", "type", "key", "scroll"].includes(input.action)) return "browser-use-browser-tool";
	if (tier === "click" && ["type", "key"].includes(input.action)) return "terminal-use-shell";
	return "";
}

/** One action, whatever comes of it. */
export async function runComputer(input: ComputerInput, deps: ComputerDeps): Promise<Outcome> {
	const { state, breaker } = deps;
	const { action } = input;
	const key = `${action}\n${state.pid}\n${input.ref ?? input.name ?? ""}`;
	try {
		if (!breaker.allows(key)) return outcome("refused", action, "user", "tried-twice");
		const driver = await deps.driver();
		if (!driver) return outcome("failed", action, "user", "not-installed");
		if (action === "windows") return await listWindows(driver);
		if (input.pid !== undefined) state.pid = input.pid;
		if (input.window !== undefined) state.window = input.window;
		// Every action but launch is on one known window: the driver is never asked without one.
		if (action !== "launch" && (state.pid === undefined || state.window === undefined))
			return outcome("refused", action, "model", "no-window");
		const scope = input.name ?? (state.app || String(state.pid));
		const refused = tierRefusal(input, appTier(scope));
		if (refused) return outcome("refused", action, "user", refused);
		const label = state.labels.get(input.ref ?? "");
		if (action === "type" && isSecretField(label?.role ?? "", "", label?.name ?? ""))
			return outcome("refused", "type", "user", "password-field");
		if (action !== "look") {
			const risk =
				action === "read"
					? "read"
					: action === "launch"
						? "act"
						: action === "click"
							? riskOfLabel(label?.name ?? "")
							: "act";
			const refusal = await deps.permit({
				risk,
				scope,
				title: deps.ask(action, scope),
				detail: label?.name ?? input.name ?? input.text ?? "",
			});
			if (refusal) return outcome("refused", action, "user", refusal);
		}
		const target = { pid: state.pid, window_id: state.window };
		/** The action on its row. */
		const onRow = async (ref: string | undefined): Promise<Outcome> =>
			action === "type"
				? typeInto(driver, deps, { ...input, ref })
				: settled(
						driver,
						deps,
						action,
						await driver.call("click", { ...target, element_token: tokenOf(state, ref) }),
					);
		let result: Outcome;
		if (action === "read") result = await readWindow(driver, deps);
		else if (action === "launch")
			result = replyOutcome(action, await driver.call("launch_app", { name: input.name }));
		else if (action === "type" || action === "click") {
			result = await onRow(input.ref);
			// The window changed under the row: the program finds it again, and only if there is no doubt.
			if (result.reason === STALE_TOKEN) {
				await readWindow(driver, deps);
				const row = sameRow(state, label);
				result = row ? await onRow(row) : outcome("failed", action, "model", "stale-ref");
			}
		} else if (action === "key")
			result = await settled(driver, deps, action, await driver.call("press_key", { ...target, key: input.key }));
		else if (action === "scroll")
			result = await settled(
				driver,
				deps,
				action,
				await driver.call("scroll", { ...target, direction: input.direction ?? "down", amount: input.amount ?? 3 }),
			);
		else {
			const shot = await driver.call("get_window_state", {
				...target,
				include_screenshot: true,
				include_accessibility_tree: false,
				max_image_dimension: deps.vision.edge,
			});
			if (!shot.image) return outcome("failed", "look", "user", String(shot.structured.code ?? "no-picture"));
			result = await sendOrRead(
				deps,
				{ ...shot.image, scope, reason: input.reason, size: `≤${deps.vision.edge}` },
				Boolean(input.ref),
			);
		}
		if (result.effect === "failed" || (result.effect === "refused" && result.next === "model")) {
			const stopped = breaker.failed(key);
			return stopped ? { ...result, next: "user" } : result;
		}
		breaker.passed(key);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return outcome("failed", action, breaker.failed(key) ? "user" : "model", "error", {
			message: message.slice(0, 300),
		});
	}
}
