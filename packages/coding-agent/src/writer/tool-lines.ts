/**
 * One line for each browser and computer action in the chat, in the interface language, instead of the raw request
 * and the JSON and accessibility tree the model reads (2026-11-22: a demo recording showed `{"effect":"confirmed",
 * "route":"keyboard",…}` and whole window trees under every step). The full text stays in the detailed view (Ctrl+O).
 */

// The rows drawn in the chat.
import { type Component, Text } from "@earendil-works/pi-tui";
// The tool result and its render options.
import type { AgentToolResult } from "../core/extensions/types.ts";
// Colours.
import type { Theme } from "../modes/interactive/theme/theme.ts";
// The interface language.
import { currentLang } from "./i18n/index.ts";
// The shape of every result.
import type { Effect, Next } from "./protocol.ts";

/** Words for the tools and their actions, Chinese and English. */
const WORDS: Readonly<Record<string, readonly [string, string]>> = {
	browser: ["浏览器", "Browser"],
	computer: ["桌面", "Desktop"],
	open: ["打开", "Open"],
	read: ["读取", "Read"],
	find: ["查找", "Find"],
	click: ["点击", "Click"],
	hover: ["悬停", "Hover"],
	type: ["输入", "Type"],
	select: ["选择", "Select"],
	key: ["按键", "Key"],
	scroll: ["滚动", "Scroll"],
	drag: ["拖动", "Drag"],
	upload: ["上传", "Upload"],
	wait: ["等待", "Wait"],
	back: ["返回", "Back"],
	tabs: ["查看标签页", "Tabs"],
	dialog: ["处理对话框", "Dialog"],
	eval: ["运行脚本", "Run script"],
	look: ["查看画面", "Look"],
	point: ["点击画面位置", "Click point"],
	windows: ["查看窗口", "Windows"],
	launch: ["启动", "Launch"],
	page: ["页面", "page"],
	window: ["窗口", "window"],
	unconfirmed: ["未能确认变化", "change not confirmed"],
	failed: ["失败", "failed"],
	needsYou: ["需要你处理", "needs you"],
	notDone: ["未执行", "not done"],
};

/** Reasons in plain words; others are shown as the program names them. */
const REASONS: Readonly<Record<string, readonly [string, string]>> = {
	"not-connected": ["没有连上 Chrome 扩展", "the Chrome extension is not connected"],
	"not-installed": ["还没有安装桌面控制组件", "desktop control is not installed"],
	declined: ["你没有同意", "you declined"],
	"tried-twice": ["同一操作已经失败两次", "the same action failed twice"],
	"no-window": ["还没有选定窗口", "no window chosen yet"],
	"no-ref": ["没有指明控件", "no control named"],
	"no-change": ["界面没有变化", "nothing changed"],
	"password-field": ["不在口令框里输入", "it does not type into password fields"],
	"cannot-type-text": ["这段文字无法输入", "this text cannot be typed"],
	element_bounds_unavailable: ["控件没有屏幕位置", "the control has no position on screen"],
	invalid_element_token: ["控件编号已过期", "the control reference is out of date"],
	"stale-ref": ["界面已变化，找不到原来的控件", "the window changed and the control is gone"],
	error: ["出错", "error"],
};

/** A word in the interface language. */
function word(key: string): string {
	const pair = WORDS[key] ?? REASONS[key];
	if (!pair) return key;
	return currentLang() === "zh" ? pair[0] : pair[1];
}

/** At most this many characters of a quoted value. */
const QUOTE_CHARS = 40;

/** A value cut to fit one line. */
function short(text: string, max = QUOTE_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A web address without its scheme and "www.", cut to fit. */
function shortUrl(url: string): string {
	return short(url.replace(/^https?:\/\//, "").replace(/^www\./, ""), 60);
}

/** What one browser or computer request is, as the user reads it: the tool, the action and its object. */
export function actionLine(tool: "browser" | "computer", args: Record<string, unknown>): string {
	const action = String(args.action ?? "");
	const text = typeof args.text === "string" ? args.text : "";
	const target =
		action === "open" && typeof args.url === "string"
			? shortUrl(args.url)
			: action === "type"
				? `「${short(text)}」`
				: action === "launch" && typeof args.name === "string"
					? args.name
					: action === "key" && typeof args.key === "string"
						? args.key
						: action === "select" && typeof args.option === "string"
							? `「${short(args.option)}」`
							: action === "find" && typeof args.query === "string"
								? `「${short(args.query)}」`
								: action === "wait" && text
									? `「${short(text)}」`
									: action === "read"
										? word(tool === "browser" ? "page" : "window")
										: typeof args.ref === "string"
											? args.ref
											: "";
	return `${word(tool)} · ${word(action)}${target ? ` ${target}` : ""}`;
}

/** What the result line says, and how loudly; undefined when there is nothing to add (it was done). */
export interface OutcomeLine {
	text: string;
	tone: "dim" | "warning";
}

/** The model's first line of a result: the outcome JSON, with the page's title or an error message in its data. */
interface OutcomeJson {
	effect?: Effect;
	next?: Next;
	reason?: string;
	data?: { title?: unknown; message?: unknown };
}

/** The result of one action as the user reads it. */
export function outcomeLine(resultText: string): OutcomeLine | undefined {
	let outcome: OutcomeJson;
	try {
		outcome = JSON.parse(resultText.split("\n", 1)[0] ?? "") as OutcomeJson;
	} catch {
		return undefined;
	}
	const reason = outcome.reason ? word(outcome.reason) : "";
	if (outcome.effect === "confirmed") {
		const title = typeof outcome.data?.title === "string" ? short(outcome.data.title, 60) : "";
		return title ? { text: `「${title}」`, tone: "dim" } : undefined;
	}
	if (outcome.effect === "unverifiable") return { text: word("unconfirmed"), tone: "dim" };
	if (outcome.next === "user") return { text: `${word("needsYou")}：${reason}`, tone: "warning" };
	if (outcome.effect === "failed") {
		const message = typeof outcome.data?.message === "string" ? short(outcome.data.message, 80) : "";
		return { text: `${word("failed")}：${message || reason}`, tone: "dim" };
	}
	return { text: `${word("notDone")}：${reason}`, tone: "dim" };
}

/** A row with nothing in it. */
const EMPTY: Component = { render: () => [], invalidate: () => undefined };

/** The text the model reads from a result. */
function resultText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

/** The call and result rows of the browser or computer tool: one line each, the full text in the detailed view. */
export function actionRenderers(tool: "browser" | "computer") {
	return {
		renderCall: (args: unknown, theme: Theme): Component =>
			new Text(theme.fg("toolTitle", actionLine(tool, (args ?? {}) as Record<string, unknown>)), 0, 0),
		renderResult: (
			result: AgentToolResult<unknown>,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
		): Component => {
			if (options.isPartial) return EMPTY;
			const text = resultText(result);
			if (options.expanded) return new Text(theme.fg("dim", text), 0, 0);
			const line = outcomeLine(text);
			return line ? new Text(theme.fg(line.tone, line.text), 0, 0) : EMPTY;
		},
	};
}
