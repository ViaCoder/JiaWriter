/**
 * Permission modes for tools that act on the user's pages and desktop: manual, auto and bypass. What needs asking
 * comes from a fixed table and fixed rules here, never from the model. bash, write and edit use the same gate
 * through writer-permission, with their risk from tool-risk.ts.
 */

// The settings file shared with /lang.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Its folder.
import { dirname } from "node:path";
// Where the settings live.
import { uiSettingsPath } from "./i18n/index.ts";

/** How much the program asks. */
export type PermissionMode = "manual" | "auto" | "bypass";

/** How much an action can do. */
export type Risk = "read" | "act" | "high";

/** The modes, for commands and pages. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "bypass"];

/** The mode unless one is chosen. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/** One action that may need the user. */
export interface PermissionRequest {
	// How much it can do.
	risk: Risk;
	// The site or application it touches: an answer once for a scope lasts the session.
	scope: string;
	// The question.
	title: string;
	// What will happen, such as the code to run.
	detail: string;
}

/** What the gate needs of the interface. */
export interface PermissionUi {
	// False when nobody can answer.
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

/** Why an action was stopped; empty means it may go on. */
export type PermissionRefusal = "" | "declined" | "no-user";

/** Labels of controls that send, delete or pay: a click on one cannot be taken back. */
const HIGH_RISK_LABEL =
	/提交|发送|发布|删除|移除|清空|支付|付款|购买|下单|转账|\b(?:submit|send|post|publish|delete|remove|pay|buy|purchase|order|checkout|transfer)\b/i;

/** A mode from text, or undefined when it is none. */
export function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
	const v = (value ?? "").trim().toLowerCase();
	return PERMISSION_MODES.find((mode) => mode === v);
}

/** The mode chosen with /jw permission, or undefined. */
export function savedPermissionMode(): PermissionMode | undefined {
	try {
		const raw = JSON.parse(readFileSync(uiSettingsPath(), "utf-8")) as { permission?: string };
		return parsePermissionMode(raw.permission);
	} catch {
		// No choice made yet.
		return undefined;
	}
}

/** The mode chosen with Shift+Tab for this session only, as in Claude Code; never saved. */
let sessionMode: PermissionMode | undefined;
/** Plan mode (/plan or Shift+Tab): look and plan, change nothing. */
let planning = false;

/** The mode in effect: this session's choice, then JW_PERMISSION, then the saved choice, then the default. */
export function permissionMode(env: NodeJS.ProcessEnv = process.env): PermissionMode {
	return sessionMode ?? parsePermissionMode(env.JW_PERMISSION) ?? savedPermissionMode() ?? DEFAULT_PERMISSION_MODE;
}

/** Set this session's mode (undefined: back to the saved one). */
export function setSessionPermissionMode(mode: PermissionMode | undefined): void {
	sessionMode = mode;
}

/** Whether plan mode is on. */
export function isPlanning(): boolean {
	return planning;
}

/** Turn plan mode on or off. */
export function setPlanning(on: boolean): void {
	planning = on;
}

/** What the status line names: a permission mode, or plan. */
export type WorkMode = PermissionMode | "plan";

/** The work mode in effect. */
export function workMode(env: NodeJS.ProcessEnv = process.env): WorkMode {
	return planning ? "plan" : permissionMode(env);
}

/**
 * The mode after this one for Shift+Tab: manual → auto → plan → manual, as Claude Code cycles default, accept
 * edits and plan. bypass joins the cycle only when it is the mode set outside the session (as Claude Code shows its
 * bypass mode only when started with it).
 */
export function nextWorkMode(current: WorkMode, env: NodeJS.ProcessEnv = process.env): WorkMode {
	const outside = parsePermissionMode(env.JW_PERMISSION) ?? savedPermissionMode();
	const cycle: WorkMode[] = outside === "bypass" ? ["manual", "auto", "bypass", "plan"] : ["manual", "auto", "plan"];
	const at = cycle.indexOf(current);
	return cycle[(at + 1) % cycle.length];
}

/** Put a work mode in effect for this session. */
export function applyWorkMode(mode: WorkMode): void {
	planning = mode === "plan";
	if (mode !== "plan") sessionMode = mode;
}

/** Save the choice beside the other settings (atomic write). */
export function savePermissionMode(mode: PermissionMode): void {
	const path = uiSettingsPath();
	// Other settings stay.
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		// First setting.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...settings, permission: mode }, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

/** Whether an action must be put to the user; `seen` says the user already allowed this scope in this session. */
export function needsAsking(mode: PermissionMode, risk: Risk, seen: boolean): boolean {
	// Nothing is asked.
	if (mode === "bypass") return false;
	// Reading is free in auto, and asked once per scope in manual.
	if (risk === "read") return mode === "manual" && !seen;
	// Ordinary actions are asked once per scope in auto, every time in manual.
	if (risk === "act") return mode === "manual" || !seen;
	// High risk is always asked.
	return true;
}

/** The risk of acting on a control with this label. */
export function riskOfLabel(label: string): Risk {
	return HIGH_RISK_LABEL.test(label) ? "high" : "act";
}

/** Names a secret field goes by, for systems that mark none: UI Automation's password flag is not passed on by the driver. */
const SECRET_NAME = /密码|口令|验证码|passwor|passcode|\bpin\b|\bpwd\b/i;

/** True for a field that holds a password or a one-time code: no mode types into one. */
export function isSecretField(role: string, inputType: string, name = ""): boolean {
	return inputType.toLowerCase() === "password" || /secure|password/i.test(role) || SECRET_NAME.test(name);
}

/** The gate of one session. */
export interface PermissionGate {
	// Ask when the table says so; gives why the action must stop, or "".
	check(ctx: PermissionUi, request: PermissionRequest): Promise<PermissionRefusal>;
	// Forget this session's answers.
	reset(): void;
}

/** A gate with no answers yet. */
export function createPermissionGate(env: NodeJS.ProcessEnv = process.env): PermissionGate {
	// Scopes the user allowed, per risk.
	const allowed = new Set<string>();
	return {
		async check(ctx, request) {
			const key = `${request.risk}\n${request.scope}`;
			if (!needsAsking(permissionMode(env), request.risk, allowed.has(key))) return "";
			// Nobody to ask: a question becomes a refusal.
			if (!ctx.hasUI) return "no-user";
			if (!(await ctx.ui.confirm(request.title, request.detail))) return "declined";
			allowed.add(key);
			return "";
		},
		reset() {
			allowed.clear();
		},
	};
}
