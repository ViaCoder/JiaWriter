// The browser tool's rules (src/writer/browser/agent.ts), with the extension replaced by a script of replies.
import { describe, expect, it } from "vitest";
import {
	type BrowserDeps,
	type BrowserInput,
	capturePage,
	evalIn,
	labelsOf,
	lookAt,
	matchLines,
	newBrowserState,
	pageOp,
	pageOutcome,
	pointAt,
	readTab,
	riskOf,
	runBrowser,
	sendOrRead,
	siteOf,
	waitOn,
	walled,
} from "../../src/writer/browser/agent.ts";
import { BridgeError, BridgeUnavailable } from "../../src/writer/browser/bridge.ts";
import type { PermissionRefusal } from "../../src/writer/permission.ts";
import { createBreaker } from "../../src/writer/protocol.ts";
import { createImageLedger } from "../../src/writer/vision.ts";

const CLEAR_PAGE = JSON.stringify({
	title: "t",
	textLen: 900,
	excerpt: "正常页面",
	challengeIframe: false,
	cfChallenge: false,
	cfCleared: false,
});
const WALL_PAGE = JSON.stringify({
	title: "Just a moment",
	textLen: 30,
	excerpt: "verify you are human",
	challengeIframe: true,
	cfChallenge: true,
	cfCleared: false,
});
const LINES = '[e1] button "提交"\n[e2] link "下一页"\n[e3] textbox "搜索"';
const READ = { url: "https://a.example.com/", title: "A", lines: LINES, truncated: false, kind: "page" };

/** Deps whose extension answers from a table, and which log every call. */
function fake(replies: Record<string, unknown> = {}, refusal: PermissionRefusal = "") {
	const calls: [string, Record<string, unknown>][] = [];
	const asked: { risk: string; detail: string }[] = [];
	const deps: BrowserDeps = {
		call: async (op, args) => {
			calls.push([op, args]);
			const reply = replies[op];
			if (reply instanceof Error) throw reply;
			if (op === "run") return reply ?? CLEAR_PAGE;
			if (op === "page_read") return reply ?? READ;
			if (op === "open") return reply ?? { tab: 7, url: "https://a.example.com/" };
			return reply ?? {};
		},
		permit: async (request) => {
			asked.push(request);
			return refusal;
		},
		breaker: createBreaker(),
		state: newBrowserState(),
		run: "r",
		sleep: async () => undefined,
		ask: (action, scope) => `${action}@${scope}`,
		vision: {
			edge: 1024,
			ledger: createImageLedger({ turn: 1, session: 5 }),
			ocr: async () => "",
			supported: async () => true,
		},
	};
	return { deps, calls, asked };
}

/** Deps with a page open. */
async function opened(replies: Record<string, unknown> = {}, refusal: PermissionRefusal = "") {
	const made = fake(replies, refusal);
	await runBrowser({ action: "open", url: "https://a.example.com/" }, made.deps);
	made.asked.length = 0;
	return made;
}

describe("siteOf, labelsOf and matchLines", () => {
	it("reads what a line holds", () => {
		expect(siteOf("https://a.example.com/x")).toBe("a.example.com");
		expect(siteOf("nonsense")).toBe("");
		expect(labelsOf(LINES).get("e1")).toBe("提交");
		expect(labelsOf("[e9] checkbox").get("e9")).toBe("");
		expect(matchLines(LINES, "搜索")).toEqual(['[e3] textbox "搜索"']);
		expect(matchLines(LINES, "  ")).toEqual([]);
	});
});

describe("riskOf", () => {
	it("follows the action, and for a click what it presses", () => {
		const of = (input: BrowserInput, label = "") => riskOf(input, label);
		expect(of({ action: "read" })).toBe("read");
		expect(of({ action: "open" })).toBe("read");
		expect(of({ action: "type" })).toBe("act");
		expect(of({ action: "hover" })).toBe("read");
		expect(of({ action: "eval" })).toBe("high");
		expect(of({ action: "upload" })).toBe("high");
		expect(of({ action: "click" }, "下一页")).toBe("act");
		expect(of({ action: "click" }, "提交")).toBe("high");
		expect(of({ action: "dialog", accept: true })).toBe("high");
		expect(of({ action: "dialog", accept: false })).toBe("act");
	});
});

describe("runBrowser", () => {
	it("opens a page and hands the model its controls", async () => {
		const { deps } = fake();
		const result = await runBrowser({ action: "open", url: "https://a.example.com/" }, deps);
		expect(result).toMatchObject({ effect: "confirmed", next: "model" });
		expect(result.data?.lines).toBe(LINES);
		expect(deps.state.tab).toBe(7);
	});

	it("refuses an action with no page open", async () => {
		const { deps, calls } = fake();
		expect(await runBrowser({ action: "click", ref: "e1" }, deps)).toMatchObject({
			effect: "refused",
			reason: "no-page",
		});
		expect(calls.length).toBe(0);
	});

	it("stops at a verification page, and stays stopped on that site", async () => {
		const { deps, calls } = fake({ run: WALL_PAGE });
		const result = await runBrowser({ action: "open", url: "https://a.example.com/" }, deps);
		expect(result).toMatchObject({ effect: "refused", next: "user", reason: "verification" });
		const before = calls.length;
		expect(await runBrowser({ action: "read" }, deps)).toMatchObject({ reason: "held-for-user", next: "user" });
		expect(calls.length).toBe(before);
	});

	it("reports a page with no tree to the user, not the model", async () => {
		const { deps } = fake({ page_read: { ...READ, lines: "", kind: "canvas" } });
		const result = await runBrowser({ action: "open", url: "https://a.example.com/" }, deps);
		expect(result).toMatchObject({ effect: "unverifiable", next: "user", reason: "no-tree:canvas" });
	});

	it("asks by what a click presses", async () => {
		const { deps, asked } = await opened({ page_click: { route: "click", changed: true } });
		await runBrowser({ action: "click", ref: "e1" }, deps);
		await runBrowser({ action: "click", ref: "e2" }, deps);
		expect(asked.map((a) => a.risk)).toEqual(["high", "act"]);
	});

	it("does nothing the user declined", async () => {
		const { deps, calls } = await opened();
		deps.permit = async () => "declined";
		const result = await runBrowser({ action: "click", ref: "e2" }, deps);
		expect(result).toMatchObject({ effect: "refused", next: "user", reason: "declined" });
		expect(calls.some(([op]) => op === "page_click")).toBe(false);
	});

	it("never types into a password field", async () => {
		const { deps, calls } = await opened({ page_field: { type: "password", role: "textbox" } });
		const result = await runBrowser({ action: "type", ref: "e3", text: "x" }, deps);
		expect(result).toMatchObject({ effect: "refused", next: "user", reason: "password-field" });
		expect(calls.some(([op]) => op === "page_type")).toBe(false);
	});

	it("tells a changed page from an unchanged one", async () => {
		const yes = await opened({ page_click: { route: "click", changed: true, url: "https://a.example.com/2" } });
		expect(await runBrowser({ action: "click", ref: "e2" }, yes.deps)).toMatchObject({
			effect: "confirmed",
			next: "model",
		});
		expect(yes.deps.state.url).toBe("https://a.example.com/2");
		const no = await opened({ page_click: { route: "click", changed: false } });
		expect(await runBrowser({ action: "click", ref: "e2" }, no.deps)).toMatchObject({
			effect: "unverifiable",
			reason: "no-change",
		});
	});

	it("reads typing back", async () => {
		const held = await opened({ page_field: {}, page_type: { route: "insert", holds: true } });
		expect(await runBrowser({ action: "type", ref: "e3", text: "x" }, held.deps)).toMatchObject({
			effect: "confirmed",
		});
		const lost = await opened({ page_field: {}, page_type: { route: "insert", holds: false } });
		expect(await runBrowser({ action: "type", ref: "e3", text: "x" }, lost.deps)).toMatchObject({
			reason: "not-in-field",
		});
	});

	it("reports a dialog before anything else", async () => {
		const { deps } = await opened({
			page_click: { route: "click", changed: true, dialog: { type: "alert", message: "m" } },
		});
		expect(await runBrowser({ action: "click", ref: "e2" }, deps)).toMatchObject({
			effect: "unverifiable",
			reason: "dialog",
		});
	});

	it("gives a stale reference to the model once, then stops", async () => {
		const { deps, calls } = await opened({ page_click: { missing: true, role: "button", name: "x" } });
		expect(await runBrowser({ action: "click", ref: "e2" }, deps)).toMatchObject({
			effect: "failed",
			next: "model",
			reason: "stale-ref",
		});
		expect(await runBrowser({ action: "click", ref: "e2" }, deps)).toMatchObject({ next: "user" });
		const before = calls.length;
		expect(await runBrowser({ action: "click", ref: "e2" }, deps)).toMatchObject({
			effect: "refused",
			reason: "tried-twice",
		});
		expect(calls.length).toBe(before);
	});

	it("follows a new tab", async () => {
		const { deps } = await opened({ page_click: { route: "click", changed: true, newTab: 9 } });
		await runBrowser({ action: "click", ref: "e2" }, deps);
		expect(deps.state.tab).toBe(9);
	});

	it("runs code in an isolated world unless told otherwise, and shows the code when asking", async () => {
		const { deps, calls, asked } = await opened({ page_eval: { value: "1" } });
		const result = await runBrowser({ action: "eval", code: "1+0" }, deps);
		expect(result).toMatchObject({ effect: "confirmed", data: { value: "1" } });
		expect(calls.at(-1)?.[1].main).toBe(false);
		expect(asked[0]).toMatchObject({ risk: "high", detail: "1+0" });
	});

	it("passes a script error to the model", async () => {
		const { deps } = await opened({ page_eval: { error: "boom" } });
		expect(await runBrowser({ action: "eval", code: "x" }, deps)).toMatchObject({
			effect: "failed",
			next: "model",
			reason: "script-error",
		});
	});

	it("leaves setup to the user", async () => {
		const { deps } = fake({ open: new BridgeUnavailable("no") });
		expect(await runBrowser({ action: "open", url: "https://a.example.com/" }, deps)).toMatchObject({
			next: "user",
			reason: "not-connected",
		});
		const old = await opened({ page_click: new BridgeError("unknown op page_click") });
		expect(await runBrowser({ action: "click", ref: "e2" }, old.deps)).toMatchObject({
			next: "user",
			reason: "extension-old",
		});
	});

	it("forgets a tab that was closed", async () => {
		const { deps } = await opened({ page_click: new BridgeError("not a JiaWriter tab") });
		expect(await runBrowser({ action: "click", ref: "e2" }, deps)).toMatchObject({
			reason: "tab-gone",
			next: "model",
		});
		expect(deps.state.tab).toBeUndefined();
	});

	it("waits for words, within the limit", async () => {
		const { deps } = await opened();
		expect(await runBrowser({ action: "wait", text: "下一页", seconds: 1 }, deps)).toMatchObject({
			effect: "confirmed",
		});
		expect(await runBrowser({ action: "wait", text: "没有的词", seconds: 1 }, deps)).toMatchObject({
			effect: "unverifiable",
			reason: "not-seen",
		});
	});
});

describe("newBrowserState", () => {
	it("starts with nothing open", () => {
		expect(newBrowserState()).toMatchObject({ url: "", dialog: false });
		expect(newBrowserState().tab).toBeUndefined();
	});
});

describe("pageOp", () => {
	it("maps each action on a tab to one operation", () => {
		const table: [BrowserInput, string][] = [
			[{ action: "click" }, "page_click"],
			[{ action: "hover" }, "page_hover"],
			[{ action: "type" }, "page_type"],
			[{ action: "select" }, "page_select"],
			[{ action: "key" }, "page_key"],
			[{ action: "scroll" }, "page_scroll"],
			[{ action: "drag" }, "page_drag"],
			[{ action: "upload" }, "page_upload"],
			[{ action: "dialog" }, "page_dialog"],
		];
		for (const [input, op] of table) expect(pageOp(input)[0]).toBe(op);
		expect(pageOp({ action: "type", ref: "e1", text: "x", clear: true })[1]).toMatchObject({
			ref: "e1",
			text: "x",
			clear: true,
		});
	});
});

describe("walled", () => {
	it("reads the page in its own world, and takes no answer as no wall", async () => {
		const wall = fake({ run: WALL_PAGE });
		expect(await walled(wall.deps, 1)).toBe(true);
		expect(wall.calls[0][1].world).toBe("MAIN");
		expect(await walled(fake({ run: "not json" }).deps, 1)).toBe(false);
		expect(await walled(fake({ run: new BridgeError("x") }).deps, 1)).toBe(false);
	});
});

describe("readTab", () => {
	it("remembers the references, and find gives matching lines only", async () => {
		const { deps } = fake();
		deps.state.tab = 7;
		const result = await readTab(deps, { action: "find", query: "下一页" });
		expect(result.data?.lines).toBe('[e2] link "下一页"');
		expect(deps.state.labels.get("e1")).toBe("提交");
	});
});

describe("pageOutcome", () => {
	const breaker = () => createBreaker();
	it("keeps a window that must come forward with the user", () => {
		expect(pageOutcome({ action: "drag" }, { refused: true, reason: "needs-front" }, "k", breaker())).toMatchObject({
			next: "user",
		});
		expect(pageOutcome({ action: "click" }, { refused: true, reason: "other" }, "k", breaker())).toMatchObject({
			next: "model",
		});
	});
	it("says hidden for a target with no box", () => {
		expect(pageOutcome({ action: "click" }, { missing: true, hidden: true }, "k", breaker())).toMatchObject({
			reason: "hidden",
		});
	});
	it("clears the count on success", () => {
		const b = breaker();
		pageOutcome({ action: "click" }, { missing: true }, "k", b);
		pageOutcome({ action: "click" }, { changed: true }, "k", b);
		expect(pageOutcome({ action: "click" }, { missing: true }, "k", b).next).toBe("model");
	});
});

describe("waitOn", () => {
	it("waits the time asked, never past the limit", async () => {
		const { deps } = fake();
		const waits: number[] = [];
		deps.sleep = async (ms) => void waits.push(ms);
		await waitOn(deps, { action: "wait", seconds: 999 });
		expect(waits).toEqual([15000]);
	});
});

describe("evalIn", () => {
	it("passes the world on", async () => {
		const { deps, calls } = fake({ page_eval: { value: "1" } });
		await evalIn(deps, { action: "eval", code: "1", main: true });
		expect(calls[0][1].main).toBe(true);
	});
});

describe("runBrowser with a dialog open", () => {
	it("lets nothing but the answer through, and goes on after it", async () => {
		const { deps } = await opened({
			page_click: { route: "click", changed: true, dialog: { type: "alert", message: "m" } },
			page_dialog: { route: "dialog", changed: true },
		});
		await runBrowser({ action: "click", ref: "e2" }, deps);
		expect(await runBrowser({ action: "read" }, deps)).toMatchObject({ effect: "refused", reason: "dialog-open" });
		expect(await runBrowser({ action: "dialog", accept: true }, deps)).toMatchObject({ effect: "confirmed" });
		expect(deps.state.dialog).toBe(false);
	});
});

describe("how long the rules take", () => {
	it("handles a page of 20000 lines in under 100 ms", () => {
		const lines = Array.from({ length: 20000 }, (_, i) => `[e${i}] link "条目${i}"`).join("\n");
		const started = performance.now();
		expect(labelsOf(lines).size).toBe(20000);
		expect(matchLines(lines, "条目19999").length).toBe(1);
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe("capturePage", () => {
	it("asks for the size the session allows", async () => {
		const { deps, calls } = await opened({
			page_capture: { data: "x", x: 0, y: 0, width: 1, height: 1, scale: 1, url: "u" },
		});
		await capturePage(deps, { action: "look", ref: "e1" });
		expect(calls.at(-1)?.[1]).toMatchObject({ ref: "e1", edge: 1024 });
	});
});

describe("lookAt", () => {
	const shot = {
		data: "UElD",
		mimeType: "image/jpeg",
		x: 0,
		y: 0,
		width: 2000,
		height: 1000,
		scale: 0.5,
		url: "https://a.example.com/",
	};
	const input = { action: "look" as const, reason: "看" };

	it("wants a reason, and a read first", async () => {
		const { deps, calls } = await opened({ page_capture: shot });
		expect(await lookAt({ action: "look" }, deps)).toMatchObject({ reason: "reason-required" });
		deps.state.readUrl = "";
		expect(await lookAt(input, deps)).toMatchObject({ reason: "read-first", next: "model" });
		expect(calls.some(([op]) => op === "page_capture")).toBe(false);
	});

	it("takes words read on this machine first, and goes on only when asked again", async () => {
		const { deps, asked } = await opened({ page_capture: shot });
		deps.vision.ocr = async () => "本机读到了足够多的文字内容";
		expect(await lookAt(input, deps)).toMatchObject({ route: "ocr", data: { lines: "本机读到了足够多的文字内容" } });
		expect(asked.length).toBe(0);
		expect(await lookAt(input, deps)).toMatchObject({ route: "look", effect: "confirmed" });
		expect(asked.length).toBe(1);
	});

	it("ignores a few stray characters from the recognizer", async () => {
		const { deps } = await opened({ page_capture: shot });
		deps.vision.ocr = async () => "x y";
		expect(await lookAt(input, deps)).toMatchObject({ route: "look" });
	});

	it("asks before finding out, because finding out can cost a request", async () => {
		const { deps } = await opened({ page_capture: shot });
		let probed = false;
		deps.vision.supported = async () => {
			probed = true;
			return true;
		};
		deps.permit = async () => "declined";
		expect(await lookAt(input, deps)).toMatchObject({ reason: "declined", next: "user" });
		expect(probed).toBe(false);
	});

	it("stops on an upstream that takes no images, or may not", async () => {
		for (const answer of [false, undefined]) {
			const { deps } = await opened({ page_capture: shot });
			deps.vision.supported = async () => answer;
			expect(await lookAt(input, deps)).toMatchObject({ reason: "no-image-input", next: "user" });
		}
	});

	it("sends a picture once, and a view at low detail", async () => {
		const { deps } = await opened({ page_capture: shot });
		const first = await lookAt(input, deps);
		expect(first.data).toMatchObject({ size: "1000×500", picture: { detail: "low" } });
		expect(await lookAt(input, deps)).toMatchObject({ reason: "unchanged" });
	});

	it("stops at the limit, with the user", async () => {
		const { deps } = await opened({ page_capture: shot });
		deps.vision.ledger.spend("other");
		expect(await lookAt(input, deps)).toMatchObject({ reason: "image-budget", next: "user" });
	});
});

describe("pointAt", () => {
	const capture = { id: "c1", url: "https://a.example.com/", scale: 0.5, x: 10, y: 20, width: 100, height: 100 };

	it("turns a point in the picture into one on the page, and spends the picture", async () => {
		const { deps, calls } = await opened({ page_point: { route: "click", changed: true } });
		deps.state.capture = capture;
		expect(await pointAt({ action: "point", capture: "c1", x: 10, y: 10 }, deps)).toMatchObject({
			effect: "confirmed",
		});
		expect(calls.at(-1)?.[1]).toMatchObject({ x: 30, y: 40 });
		expect(deps.state.capture).toBeUndefined();
	});

	it("refuses an old picture, or a point outside it", async () => {
		const { deps } = await opened();
		deps.state.capture = capture;
		expect(await pointAt({ action: "point", capture: "other", x: 1, y: 1 }, deps)).toMatchObject({
			reason: "capture-stale",
		});
		expect(await pointAt({ action: "point", capture: "c1", x: 900, y: 1 }, deps)).toMatchObject({
			reason: "outside-capture",
		});
		deps.state.url = "https://a.example.com/moved";
		expect(await pointAt({ action: "point", capture: "c1", x: 1, y: 1 }, deps)).toMatchObject({
			reason: "capture-stale",
		});
	});
});

describe("sendOrRead", () => {
	it("marks a part for reading and a whole view for finding one's way", async () => {
		const shot = { data: "UElD", mimeType: "image/png", scope: "s", size: "1×1" };
		const part = await sendOrRead(fake().deps, shot, true);
		expect(part.data?.picture).toMatchObject({ detail: "auto" });
		const whole = await sendOrRead(fake().deps, shot, false);
		expect(whole.data?.picture).toMatchObject({ detail: "low" });
	});
});
