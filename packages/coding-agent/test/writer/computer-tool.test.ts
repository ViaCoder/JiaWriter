// The computer tool's rules (src/writer/computer/tool.ts), with the driver replaced by a table of answers.
import { describe, expect, it } from "vitest";
import type { DriverClient, DriverReply } from "../../src/writer/computer/client.ts";
import {
	appTier,
	type ComputerDeps,
	listWindows,
	needsValueRoute,
	newComputerState,
	readWindow,
	replyOutcome,
	runComputer,
	sameRow,
	settled,
	tierRefusal,
	tokenOf,
	treeLabels,
	typeInto,
} from "../../src/writer/computer/tool.ts";
import type { PermissionRefusal } from "../../src/writer/permission.ts";
import { createBreaker } from "../../src/writer/protocol.ts";
import { createImageLedger } from "../../src/writer/vision.ts";

const TREE =
	'- frame = "测试窗口"\n    - [0] text "姓名" [actions=[activate]]\n    - [1] password text "口令" [actions=[activate]]\n    - [2] push button "删除" [actions=[click]]\n';
const reply = (structured: Record<string, unknown> = {}, more: Partial<DriverReply> = {}): DriverReply => ({
	structured,
	text: "",
	failed: false,
	...more,
});
const READ = reply({ tree_markdown: TREE, snapshot_id: "s1", element_count: 3 });

/** Deps whose driver answers from a table. */
function fake(answers: Record<string, DriverReply | Error> = {}, refusal: PermissionRefusal = "") {
	const calls: [string, Record<string, unknown>][] = [];
	const asked: { risk: string }[] = [];
	const client: DriverClient = {
		call: async (tool, args) => {
			calls.push([tool, args]);
			const answer =
				answers[tool] ??
				(tool === "get_window_state" ? READ : reply({ effect: "confirmed", route: "accessibility" }));
			if (answer instanceof Error) throw answer;
			return answer;
		},
		close: () => undefined,
	};
	const deps: ComputerDeps = {
		driver: async () => client,
		permit: async (request) => {
			asked.push(request);
			return refusal;
		},
		breaker: createBreaker(),
		state: newComputerState(),
		ask: (action, scope) => `${action}@${scope}`,
		vision: {
			edge: 1024,
			ledger: createImageLedger({ turn: 1, session: 5 }),
			ocr: async () => "",
			supported: async () => true,
		},
	};
	return { deps, client, calls, asked };
}

/** Deps with a window read. */
async function reading(answers: Record<string, DriverReply | Error> = {}) {
	const made = fake(answers);
	await runComputer({ action: "read", pid: 5, window: 9 }, made.deps);
	made.calls.length = 0;
	made.asked.length = 0;
	return made;
}

describe("appTier and tierRefusal", () => {
	it("leaves browsers to the browser tool and terminals to the shell", () => {
		expect(appTier("Google Chrome")).toBe("read");
		expect(appTier("iTerm2")).toBe("click");
		expect(appTier("Visual Studio Code")).toBe("click");
		expect(appTier("计算器")).toBe("full");
		expect(tierRefusal({ action: "click" }, "read")).toBe("browser-use-browser-tool");
		expect(tierRefusal({ action: "read" }, "read")).toBe("");
		expect(tierRefusal({ action: "type" }, "click")).toBe("terminal-use-shell");
		expect(tierRefusal({ action: "click" }, "click")).toBe("");
		expect(tierRefusal({ action: "type" }, "full")).toBe("");
	});
});

describe("treeLabels", () => {
	it("gives each row's token, role and name", () => {
		const labels = treeLabels(TREE);
		expect(labels.get("1")).toEqual({ role: "password text", name: "口令" });
		expect(labels.get("2")?.name).toBe("删除");
	});
	it("reads a tree of 20000 rows in under 100 ms", () => {
		const tree = Array.from(
			{ length: 20000 },
			(_, i) => `    - [${i}] push button "按钮${i}" [actions=[click]]`,
		).join("\n");
		const started = performance.now();
		expect(treeLabels(tree).size).toBe(20000);
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe("tokenOf and sameRow", () => {
	it("makes the driver's token from a row", () => {
		expect(tokenOf({ ...newComputerState(), snapshot: "s7" }, "2")).toBe("s7:2");
	});
	it("finds a control again only when there is no doubt", () => {
		const state = newComputerState();
		state.labels = treeLabels(`${TREE}    - [3] push button "删除" [actions=[click]]\n`);
		expect(sameRow(state, { role: "text", name: "姓名" })).toBe("0");
		expect(sameRow(state, { role: "push button", name: "删除" })).toBeUndefined();
		expect(sameRow(state, { role: "text", name: "没有" })).toBeUndefined();
		expect(sameRow(state, undefined)).toBeUndefined();
	});
});

describe("needsValueRoute", () => {
	it("marks anything beyond ASCII, which typing cuts short", () => {
		expect(needsValueRoute("虚拟")).toBe(true);
		expect(needsValueRoute("café")).toBe(true);
		expect(needsValueRoute("plain text 123")).toBe(false);
	});
});

describe("replyOutcome", () => {
	it("gives a refusal to the user: the foreground is never taken", () => {
		const result = replyOutcome("click", reply({ refusal: { code: "background_unavailable" } }, { failed: true }));
		expect(result).toMatchObject({ effect: "refused", next: "user", reason: "background_unavailable" });
	});
	it("tells success, doubt and failure apart", () => {
		expect(replyOutcome("x", reply({ effect: "confirmed", route: "accessibility" }))).toMatchObject({
			effect: "confirmed",
			route: "accessibility",
		});
		expect(replyOutcome("x", reply({ effect: "unverifiable" }))).toMatchObject({
			effect: "unverifiable",
			reason: "no-change",
		});
		expect(replyOutcome("x", reply({ code: "bad" }, { failed: true }))).toMatchObject({
			effect: "failed",
			reason: "bad",
			next: "model",
		});
	});
});

describe("listWindows", () => {
	it("gives short rows, never the full process list", async () => {
		const { client, calls } = fake({
			list_windows: reply({ windows: [{ pid: 1, window_id: 2, app_name: "A", title: "T", extra: "x" }] }),
		});
		const result = await listWindows(client);
		expect(result.data?.windows).toEqual([{ pid: 1, window: 2, app: "A", title: "T" }]);
		expect(calls[0][0]).toBe("list_windows");
	});
});

describe("readWindow", () => {
	it("asks for no picture, and remembers the references and the title", async () => {
		const { client, deps, calls } = fake();
		const result = await readWindow(client, deps);
		expect(calls[0][1].include_screenshot).toBe(false);
		expect(result.data?.lines).toContain("姓名");
		expect(deps.state.labels.size).toBe(3);
		expect(deps.state.app).toBe("测试窗口");
	});
	it("leaves an empty window to the user", async () => {
		const { client, deps } = fake({ get_window_state: reply({ tree_markdown: "", element_count: 0 }) });
		expect(await readWindow(client, deps)).toMatchObject({ next: "user", reason: "no-tree" });
	});
});

describe("settled", () => {
	it("reads once when the driver is unsure, asking for changes only", async () => {
		const { client, deps, calls } = fake({ get_window_state: reply({ diff_counts: { changed: 1 } }) });
		expect(await settled(client, deps, "click", reply({ effect: "unverifiable" }))).toMatchObject({
			effect: "confirmed",
		});
		expect(calls.length).toBe(1);
		expect(calls[0][1].since).toBe("latest");
	});
	it("stays unsure when nothing changed, and costs nothing on a clear answer", async () => {
		const same = fake({ get_window_state: reply({ diff_counts: { changed: 0 } }) });
		expect(await settled(same.client, same.deps, "click", reply({ effect: "unverifiable" }))).toMatchObject({
			effect: "unverifiable",
		});
		const sure = fake();
		await settled(sure.client, sure.deps, "click", reply({ effect: "confirmed" }));
		expect(sure.calls.length).toBe(0);
	});
});

describe("typeInto", () => {
	it("writes by value first", async () => {
		const { client, deps, calls } = fake();
		await typeInto(client, deps, { action: "type", ref: "0", text: "虚拟桌面文字" });
		expect(calls[0]).toEqual(["set_value", expect.objectContaining({ value: "虚拟桌面文字" })]);
	});
	it("never falls back to keys for text keys would cut short", async () => {
		const { client, deps, calls } = fake({ set_value: reply({}, { failed: true }) });
		expect(await typeInto(client, deps, { action: "type", ref: "0", text: "虚拟" })).toMatchObject({
			effect: "refused",
			reason: "cannot-type-text",
		});
		expect(calls.some(([tool]) => tool === "type_text")).toBe(false);
	});
	it("falls back to keys for ASCII", async () => {
		const { client, deps, calls } = fake({ set_value: reply({}, { failed: true }) });
		await typeInto(client, deps, { action: "type", ref: "0", text: "abc" });
		expect(calls.at(-1)?.[0]).toBe("type_text");
	});
});

describe("runComputer", () => {
	it("sends setup to the user", async () => {
		const { deps } = fake();
		deps.driver = async () => undefined;
		expect(await runComputer({ action: "windows" }, deps)).toMatchObject({ next: "user", reason: "not-installed" });
	});
	it("wants a window first", async () => {
		const { deps } = fake();
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({
			reason: "no-window",
			next: "model",
		});
		// A process alone is not enough: the driver is never asked without a window.
		expect(await runComputer({ action: "read", pid: 7 }, deps)).toMatchObject({
			reason: "no-window",
			effect: "refused",
		});
	});
	it("asks by what a click presses", async () => {
		const { deps, asked } = await reading();
		await runComputer({ action: "click", ref: "2" }, deps);
		await runComputer({ action: "click", ref: "0" }, deps);
		expect(asked.map((a) => a.risk)).toEqual(["high", "act"]);
	});
	it("does nothing the user declined", async () => {
		const { deps, calls } = await reading();
		deps.permit = async () => "declined";
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({
			reason: "declined",
			next: "user",
		});
		expect(calls.length).toBe(0);
	});
	it("never types into a password field", async () => {
		const { deps, calls } = await reading();
		expect(await runComputer({ action: "type", ref: "1", text: "x" }, deps)).toMatchObject({
			reason: "password-field",
			next: "user",
		});
		expect(calls.length).toBe(0);
	});
	it("holds browsers to reading", async () => {
		const { deps } = await reading();
		deps.state.app = "Google Chrome";
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({
			reason: "browser-use-browser-tool",
			next: "user",
		});
	});
	it("runs key, scroll and launch through their tools", async () => {
		const { deps, calls } = await reading();
		await runComputer({ action: "key", key: "Return" }, deps);
		await runComputer({ action: "scroll", direction: "up" }, deps);
		await runComputer({ action: "launch", name: "gedit" }, deps);
		expect(calls.map(([tool]) => tool)).toEqual(["press_key", "scroll", "launch_app"]);
		expect(JSON.stringify(calls)).not.toContain("delivery_mode");
	});
	it("sends the driver its token, built from the row", async () => {
		const { deps, calls } = await reading();
		await runComputer({ action: "click", ref: "0" }, deps);
		expect(calls[0][1].element_token).toBe("s1:0");
	});
	it("finds a control again after the window changed, and goes on", async () => {
		const made = await reading();
		let first = true;
		const { client } = made;
		const call = client.call;
		client.call = async (tool, args) => {
			if (tool === "click" && first) {
				first = false;
				return reply({ refusal: { code: "stale_element_token" } }, { failed: true });
			}
			return call(tool, args);
		};
		expect(await runComputer({ action: "click", ref: "0" }, made.deps)).toMatchObject({ effect: "confirmed" });
		expect(made.calls.filter(([tool]) => tool === "click").length).toBe(1);
	});
	it("gives up when the control cannot be told apart", async () => {
		const { deps } = await reading({ click: reply({ refusal: { code: "stale_element_token" } }, { failed: true }) });
		deps.state.labels.set("9", { role: "text", name: "别的" });
		expect(await runComputer({ action: "click", ref: "9" }, deps)).toMatchObject({
			reason: "stale-ref",
			next: "model",
		});
	});
	it("stops on the second failure", async () => {
		const { deps } = await reading({ click: reply({ code: "stale" }, { failed: true }) });
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({ next: "model" });
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({ next: "user" });
		expect(await runComputer({ action: "click", ref: "0" }, deps)).toMatchObject({ reason: "tried-twice" });
	});
	it("keeps an error short", async () => {
		const { deps } = await reading({ click: new Error("x".repeat(900)) });
		const result = await runComputer({ action: "click", ref: "0" }, deps);
		expect(String(result.data?.message).length).toBe(300);
	});
	it("looks through the same steps as a page", async () => {
		const { deps, calls } = await reading({
			get_window_state: reply({}, { image: { data: "UElD", mimeType: "image/png" } }),
		});
		const result = await runComputer({ action: "look", reason: "看" }, deps);
		expect(result.data?.picture).toMatchObject({ data: "UElD" });
		expect(calls[0][1]).toMatchObject({ include_screenshot: true, max_image_dimension: 1024 });
		expect(await runComputer({ action: "look", reason: "再看" }, deps)).toMatchObject({ reason: "unchanged" });
	});
	it("reports a window that gave no picture", async () => {
		const { deps } = await reading({ get_window_state: reply({ code: "surface_identity_unproven" }) });
		expect(await runComputer({ action: "look", reason: "看" }, deps)).toMatchObject({
			next: "user",
			reason: "surface_identity_unproven",
		});
	});
});
