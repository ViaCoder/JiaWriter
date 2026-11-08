// Every function of the extension's agent.js, on a fake Chrome: what it does, and how many protocol commands it
// costs, since each command is time the page is held. The real Chrome run is scripts/writer-browser-check.py.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
	join(process.cwd(), "..", "..", "search_fetch", "src", "search_fetch", "extension", "agent.js"),
	"utf-8",
);
/** The file's functions, handed out at its end. */
const NAMES =
	"ownTab senderFor withPage letGo localFrames allFrames nodeLine readTree emptyPageKind senderOf resolveRef frameOffset nodeCentre onNode wheelPage viewState untilChanged untilDialog pointerTo activateNode afterAction onRef pageRefs heldDialogs";

type Fn = (...args: never[]) => Promise<never>;
type Reply = (params: Record<string, unknown>, session?: string) => unknown;

/** A page of nodes for the fake tree. */
function axNode(role: string, name: string, node: number, more: Record<string, unknown> = {}) {
	return { role: { value: role }, name: { value: name }, backendDOMNodeId: node, ...more };
}

/** A fake Chrome with the extension's helpers around agent.js. */
function load(replies: Record<string, Reply> = {}, options: { front?: boolean; tabs?: Record<number, unknown> } = {}) {
	const sent: [string, string | undefined][] = [];
	const events: ((source: { tabId: number; sessionId?: string }, method: string, params: unknown) => void)[] = [];
	const defaults: Record<string, Reply> = {
		"Page.getFrameTree": () => ({ frameTree: { frame: { id: "F" } } }),
		"Accessibility.getFullAXTree": () => ({ nodes: [axNode("button", "按钮", 1), axNode("heading", "标题", 2)] }),
		"DOM.getBoxModel": () => ({
			model: { width: 10, height: 10, border: [0, 0, 10, 0, 10, 10, 0, 10], content: [100, 200] },
		}),
		"Page.createIsolatedWorld": () => ({ executionContextId: 5 }),
		"DOM.resolveNode": () => ({ object: { objectId: "o" } }),
		"Runtime.callFunctionOn": () => ({ result: { value: { native: true, focused: true, href: "", blank: false } } }),
		"Page.getLayoutMetrics": () => ({
			cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
			cssVisualViewport: { pageY: 0 },
		}),
		"Runtime.evaluate": () => ({ result: { value: "empty" } }),
	};
	const send = (target: { sessionId?: string }, method: string, params: Record<string, unknown> = {}) => {
		sent.push([method, target.sessionId]);
		const reply = replies[method] ?? defaults[method];
		return Promise.resolve().then(() => (reply ? reply(params, target.sessionId) : {}));
	};
	const tabs = options.tabs ?? { 1: { run: "" } };
	const saved: unknown[] = [];
	const chrome = {
		debugger: {
			attach: async () => sent.push(["attach", undefined]),
			detach: async () => sent.push(["detach", undefined]),
			sendCommand: send,
			onEvent: {
				addListener: (fn: (typeof events)[number]) => events.push(fn),
				removeListener: (fn: (typeof events)[number]) => events.splice(events.indexOf(fn), 1),
			},
		},
		tabs: {
			onRemoved: { addListener: () => undefined },
			update: async () => undefined,
			get: async () => ({ id: 1, url: "u", title: "t" }),
		},
	};
	const OPS: Record<string, Fn> = {};
	const sandbox = {
		chrome,
		OPS,
		CDP_VERSION: "1.3",
		mouse: new Map(),
		registry: async () => ({ tabs }),
		saveRegistry: async (reg: unknown) => saved.push(reg),
		// Short waits pass at once; the long limit on an operation never runs out here.
		sleep: (ms: number) => (ms >= 30000 ? new Promise(() => undefined) : Promise.resolve()),
		watchNavigation: () => ({ wait: async () => ({ navigated: false, newTab: null, timedOut: false }) }),
		tabInfo: async () => ({ tab: 1, url: "u", title: "t", timedOut: false }),
		inFront: async () => options.front ?? false,
		clickHere: async () => sent.push(["click", undefined]),
		pressKey: async () => sent.push(["Enter", undefined]),
		axRole: (n: { role?: { value: string } }) => n.role?.value ?? "",
		axName: (n: { name?: { value: string } }) => n.name?.value ?? "",
		axProp: (n: { properties?: { name: string; value: { value: unknown } }[] }, name: string) =>
			n.properties?.find((p) => p.name === name)?.value.value,
		Promise,
		Map,
		Set,
		JSON,
		Object,
		String,
		Error,
	};
	vm.createContext(sandbox);
	const api = vm.runInContext(`${SOURCE}\n;({ ${NAMES.split(" ").join(", ")} })`, sandbox) as Record<string, Fn> & {
		pageRefs: Map<number, Map<string, unknown>>;
		heldDialogs: Map<number, unknown>;
	};
	return {
		api,
		OPS,
		sent,
		saved,
		tabs,
		count: (method: string) => sent.filter(([m]) => m === method).length,
		emit: (method: string, params: unknown, sessionId?: string) => {
			for (const fn of [...events]) fn({ tabId: 1, sessionId }, method, params);
		},
		listeners: () => events.length,
	};
}

/** Call a function of the file with loose arguments. */
const call = (fn: Fn, ...args: unknown[]) => (fn as unknown as (...a: unknown[]) => Promise<never>)(...args);
/** The sender of the tab itself. */
function rootSend(made: ReturnType<typeof load>) {
	return (made.api.senderFor as unknown as (t: number, s: string) => (m: string, p?: unknown) => Promise<unknown>)(
		1,
		"",
	);
}
/** A page as withPage hands it out. */
function pageOf(made: ReturnType<typeof load>, more = {}) {
	return {
		tabId: 1,
		sessions: new Map(),
		dialog: null,
		opened: new Promise(() => undefined),
		send: rootSend(made),
		...more,
	};
}

describe("ownTab", () => {
	it("lets only the dedicated window's tabs through", async () => {
		const { api } = load();
		await expect(call(api.ownTab, 1)).resolves.toBeUndefined();
		await expect(call(api.ownTab, 2)).rejects.toThrow("not a JiaWriter tab");
	});
});

describe("senderFor", () => {
	it("sends to the tab, or to a child session", async () => {
		const made = load();
		const senderFor = made.api.senderFor as unknown as (t: number, s: string) => (m: string) => Promise<unknown>;
		await senderFor(1, "")("A");
		await senderFor(1, "s1")("B");
		expect(made.sent).toEqual([
			["A", undefined],
			["B", "s1"],
		]);
	});
});

describe("withPage and letGo", () => {
	it("attaches, runs, and lets go", async () => {
		const made = load();
		const result = await call(made.api.withPage, 1, async () => "done");
		expect(result).toBe("done");
		expect(made.count("attach")).toBe(1);
		expect(made.count("detach")).toBe(1);
		expect(made.listeners()).toBe(0);
	});

	it("lets go after an error too", async () => {
		const made = load();
		await expect(
			call(made.api.withPage, 1, async () => {
				throw new Error("x");
			}),
		).rejects.toThrow("x");
		expect(made.count("detach")).toBe(1);
	});

	it("collects cross-site frames, and asks each for its children", async () => {
		const made = load();
		const seen = await call(made.api.withPage, 1, async (page: { sessions: Map<string, unknown> }) => {
			made.emit("Target.attachedToTarget", { sessionId: "s1", targetInfo: { type: "iframe", targetId: "T1" } });
			made.emit("Target.attachedToTarget", { sessionId: "w", targetInfo: { type: "worker", targetId: "W" } });
			return [...page.sessions.keys()];
		});
		expect(seen).toEqual(["s1"]);
		expect(made.sent.some(([m, s]) => m === "Target.setAutoAttach" && s === "s1")).toBe(true);
	});

	it("keeps the session of an open dialog, and refuses others until it is answered", async () => {
		const made = load();
		await call(made.api.withPage, 1, async () => {
			made.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" });
		});
		expect(made.count("detach")).toBe(0);
		expect(made.api.heldDialogs.has(1)).toBe(true);
		await expect(call(made.api.withPage, 1, async () => "no")).rejects.toThrow("dialog-open");
		await call(made.api.letGo, made.api.heldDialogs.get(1));
		expect(made.api.heldDialogs.has(1)).toBe(false);
		expect(made.count("detach")).toBe(1);
	});
});

describe("localFrames", () => {
	it("lists a frame and its same-site children", () => {
		const localFrames = load().api.localFrames as unknown as (t: unknown) => string[];
		expect(
			localFrames({
				frame: { id: "a" },
				childFrames: [{ frame: { id: "b" }, childFrames: [{ frame: { id: "c" } }] }],
			}),
		).toEqual(["a", "b", "c"]);
	});
});

describe("allFrames", () => {
	it("walks every session, and skips one that went away", async () => {
		const made = load({
			"Page.getFrameTree": (_p, session) => {
				if (session === "gone") throw new Error("no");
				return { frameTree: { frame: { id: session ?? "root" } } };
			},
		});
		const sessions = new Map([
			["s1", { targetId: "T1", parent: "" }],
			["gone", { targetId: "T2", parent: "" }],
		]);
		const frames = (await call(made.api.allFrames, { tabId: 1, sessions })) as unknown as {
			frameId: string;
			target: string;
		}[];
		expect(frames.map((f) => [f.frameId, f.target])).toEqual([
			["root", ""],
			["s1", "T1"],
		]);
	});
});

describe("nodeLine", () => {
	it("shows role, name, value and state", () => {
		const nodeLine = load().api.nodeLine as unknown as (r: string, n: unknown) => string;
		expect(
			nodeLine(
				"e1",
				axNode("textbox", "名", 1, {
					value: { value: "值" },
					properties: [
						{ name: "required", value: { value: true } },
						{ name: "checked", value: { value: "false" } },
					],
				}),
			),
		).toBe('[e1] textbox "名" = "值" (required)');
		expect(nodeLine("", axNode("heading", "标题", 2))).toBe('heading "标题"');
	});
});

describe("readTree", () => {
	it("numbers controls across frames, and costs one tree per frame", async () => {
		const made = load({
			"Page.getFrameTree": (_p, session) => ({ frameTree: { frame: { id: session ?? "root" } } }),
		});
		const page = { tabId: 1, sessions: new Map([["s1", { targetId: "T1", parent: "" }]]) };
		const read = (await call(made.api.readTree, page, false)) as unknown as {
			lines: string[];
			acts: number;
			refs: Map<string, { target: string }>;
		};
		expect(read.acts).toBe(2);
		expect(read.refs.get("e2")?.target).toBe("T1");
		expect(made.count("Accessibility.getFullAXTree")).toBe(2);
	});

	it("leaves ignored nodes out, and page words unless asked", async () => {
		const nodes = [axNode("button", "藏", 1, { ignored: true }), axNode("StaticText", "字", 2)];
		const made = load({ "Accessibility.getFullAXTree": () => ({ nodes }) });
		const page = { tabId: 1, sessions: new Map() };
		expect(((await call(made.api.readTree, page, false)) as unknown as { lines: string[] }).lines).toEqual([]);
		expect(((await call(made.api.readTree, page, true)) as unknown as { lines: string[] }).lines).toEqual([
			'StaticText "字"',
		]);
	});

	it("skips a frame without a tree", async () => {
		const made = load({
			"Accessibility.getFullAXTree": () => {
				throw new Error("no");
			},
		});
		const read = (await call(made.api.readTree, { tabId: 1, sessions: new Map() }, false)) as unknown as {
			acts: number;
		};
		expect(read.acts).toBe(0);
	});

	it("reads a page of 20000 nodes in under 300 ms", async () => {
		const nodes = Array.from({ length: 20000 }, (_, i) => axNode(i % 2 ? "link" : "StaticText", `节点${i}`, i));
		const made = load({ "Accessibility.getFullAXTree": () => ({ nodes }) });
		const started = performance.now();
		const read = (await call(made.api.readTree, { tabId: 1, sessions: new Map() }, true)) as unknown as {
			acts: number;
		};
		expect(read.acts).toBe(10000);
		expect(performance.now() - started).toBeLessThan(300);
	});
});

describe("emptyPageKind", () => {
	it("runs in an isolated world, not the page's own", async () => {
		let context: unknown;
		const made = load({
			"Runtime.evaluate": (p) => {
				context = p.contextId;
				return { result: { value: "canvas" } };
			},
		});
		expect(await call(made.api.emptyPageKind, pageOf(made))).toBe("canvas");
		expect(context).toBe(5);
	});
});

describe("senderOf", () => {
	it("finds a frame's session, and null when it is gone", () => {
		const made = load();
		const senderOf = made.api.senderOf as unknown as (p: unknown, t: string) => unknown;
		const page = { tabId: 1, send: "root", sessions: new Map([["s1", { targetId: "T1" }]]) };
		expect(senderOf(page, "")).toBe("root");
		expect(typeof senderOf(page, "T1")).toBe("function");
		expect(senderOf(page, "T9")).toBeNull();
	});
});

describe("resolveRef", () => {
	const known = { target: "", frameId: "F", node: 1, role: "button", name: "按钮" };

	it("does not read the page again while the node is alive", async () => {
		const made = load();
		made.api.pageRefs.set(1, new Map([["e1", known]]));
		const hit = (await call(made.api.resolveRef, pageOf(made), "e1")) as unknown as { moved: boolean };
		expect(hit.moved).toBe(false);
		expect(made.count("Accessibility.getFullAXTree")).toBe(0);
	});

	it("says gone for a reference it never gave", async () => {
		const made = load();
		expect(await call(made.api.resolveRef, pageOf(made), "e9")).toEqual({ gone: true });
	});

	it("finds a replaced node by its role and name when only one matches", async () => {
		const made = load({
			"DOM.describeNode": () => {
				throw new Error("gone");
			},
		});
		made.api.pageRefs.set(1, new Map([["e1", known]]));
		const hit = (await call(made.api.resolveRef, pageOf(made), "e1")) as unknown as { moved: boolean; node: number };
		expect(hit.moved).toBe(true);
		expect(hit.node).toBe(1);
	});

	it("refuses to guess between two matches", async () => {
		const made = load({
			"DOM.describeNode": () => {
				throw new Error("gone");
			},
			"Accessibility.getFullAXTree": () => ({ nodes: [axNode("button", "按钮", 7), axNode("button", "按钮", 8)] }),
		});
		made.api.pageRefs.set(1, new Map([["e1", known]]));
		expect(await call(made.api.resolveRef, pageOf(made), "e1")).toMatchObject({ gone: true, role: "button" });
	});
});

describe("frameOffset", () => {
	it("adds the owners' content boxes, up through nested frames", async () => {
		const made = load({ "DOM.getFrameOwner": () => ({ backendNodeId: 1 }) });
		const sessions = new Map([
			["s1", { targetId: "T1", parent: "" }],
			["s2", { targetId: "T2", parent: "s1" }],
		]);
		expect(await call(made.api.frameOffset, pageOf(made, { sessions }), "T2")).toEqual({ x: 200, y: 400 });
		expect(await call(made.api.frameOffset, pageOf(made), "")).toEqual({ x: 0, y: 0 });
	});
});

describe("nodeCentre", () => {
	const hit = (made: ReturnType<typeof load>) => ({ node: 1, target: "", send: pageOf(made).send });

	it("gives the middle of the box after scrolling it into view", async () => {
		const made = load();
		expect(await call(made.api.nodeCentre, pageOf(made), hit(made))).toEqual({ x: 5, y: 5 });
		expect(made.count("DOM.scrollIntoViewIfNeeded")).toBe(1);
	});

	it("gives null for a node with no box, or too small to press", async () => {
		const none = load({
			"DOM.getBoxModel": () => {
				throw new Error("no box");
			},
		});
		expect(await call(none.api.nodeCentre, pageOf(none), hit(none))).toBeNull();
		const tiny = load({
			"DOM.getBoxModel": () => ({ model: { width: 1, height: 1, border: [0, 0, 0, 0, 0, 0, 0, 0] } }),
		});
		expect(await call(tiny.api.nodeCentre, pageOf(tiny), hit(tiny))).toBeNull();
	});
});

describe("onNode", () => {
	it("runs in an isolated world of the node's frame", async () => {
		let worldFrame: unknown;
		const made = load({
			"Page.createIsolatedWorld": (p) => {
				worldFrame = p.frameId;
				return { executionContextId: 5 };
			},
			"Runtime.callFunctionOn": () => ({ result: { value: 7 } }),
		});
		expect(await call(made.api.onNode, { node: 1, frameId: "F9", send: pageOf(made).send }, "function () {}")).toBe(
			7,
		);
		expect(worldFrame).toBe("F9");
	});
});

describe("wheelPage", () => {
	it("turns the wheel over the middle, a screen by default", async () => {
		let wheel: Record<string, unknown> = {};
		const made = load({
			"Input.dispatchMouseEvent": (p) => {
				if (p.type === "mouseWheel") wheel = p;
				return {};
			},
		});
		await call(made.api.wheelPage, pageOf(made), undefined);
		expect(wheel).toMatchObject({ x: 400, y: 300, deltaY: 600 });
		await call(made.api.wheelPage, pageOf(made), 50);
		expect(wheel.deltaY).toBe(50);
	});
});

describe("viewState and untilChanged", () => {
	it("comes back at the first change, and stops at the limit", async () => {
		let reads = 0;
		const moving = load({
			"Accessibility.getFullAXTree": () => ({ nodes: [axNode("button", `按钮${reads++ >= 2}`, 1)] }),
		});
		const page = { ...pageOf(moving), sessions: new Map() };
		expect(await call(moving.api.untilChanged, page, '0\n[e1] button "按钮false"')).toBe(true);
		expect(moving.count("Accessibility.getFullAXTree")).toBe(3);
		const still = load({ "Accessibility.getFullAXTree": () => ({ nodes: [axNode("button", "按钮", 1)] }) });
		expect(
			await call(still.api.untilChanged, { ...pageOf(still), sessions: new Map() }, '0\n[e1] button "按钮"'),
		).toBe(false);
		expect(still.count("Accessibility.getFullAXTree")).toBe(10);
	});

	it("counts a scroll that added no controls", async () => {
		let y = 0;
		const made = load({
			"Page.getLayoutMetrics": () => ({
				cssVisualViewport: { pageY: y },
				cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
			}),
		});
		const page = { ...pageOf(made), sessions: new Map() };
		const before = await call(made.api.viewState, page);
		y = 400;
		expect(await call(made.api.untilChanged, page, before)).toBe(true);
	});
});

describe("untilDialog", () => {
	it("gives up on an input that a dialog holds back", async () => {
		const made = load();
		const page = { dialog: null, opened: Promise.resolve() };
		await expect(call(made.api.untilDialog, page, new Promise(() => undefined))).resolves.toBeUndefined();
	});

	it("passes an input's failure on, unless a dialog caused it", async () => {
		const made = load();
		await expect(
			call(
				made.api.untilDialog,
				{ dialog: null, opened: new Promise(() => undefined) },
				Promise.reject(new Error("x")),
			),
		).rejects.toThrow("x");
		await expect(
			call(
				made.api.untilDialog,
				{ dialog: {}, opened: new Promise(() => undefined) },
				Promise.reject(new Error("x")),
			),
		).resolves.toBeUndefined();
	});
});

describe("pointerTo", () => {
	it("moves once, and remembers where", async () => {
		const made = load();
		await call(made.api.pointerTo, pageOf(made), 10.4, 20.6);
		expect(made.count("Input.dispatchMouseEvent")).toBe(1);
	});
});

describe("activateNode", () => {
	const at = { x: 1, y: 2 };
	const hit = (made: ReturnType<typeof load>) => ({ node: 1, frameId: "F", send: pageOf(made).send });

	it("clicks with the mouse only when the window is in front", async () => {
		const made = load({}, { front: true });
		expect(await call(made.api.activateNode, pageOf(made), hit(made), at)).toBe("click");
		expect(made.count("click")).toBe(1);
	});

	it("uses Enter on a native control behind the user's work, with no mouse press", async () => {
		const made = load();
		expect(await call(made.api.activateNode, pageOf(made), hit(made), at)).toBe("keyboard");
		expect(made.count("click")).toBe(0);
		expect(made.count("Enter")).toBe(1);
	});

	it("uses the element's click on a block that takes no Enter", async () => {
		const made = load({ "Runtime.callFunctionOn": () => ({ result: { value: { native: false, focused: true } } }) });
		expect(await call(made.api.activateNode, pageOf(made), hit(made), at)).toBe("script");
		expect(made.count("Enter")).toBe(0);
	});

	it("opens a new-tab link here, because a new tab raises the window", async () => {
		const made = load({
			"Runtime.callFunctionOn": () => ({
				result: { value: { native: true, focused: true, blank: true, href: "https://a.example.com/" } },
			}),
		});
		expect(await call(made.api.activateNode, pageOf(made), hit(made), at)).toBe("link");
	});
});

describe("afterAction", () => {
	const none = { navigated: false, newTab: null, timedOut: false };

	it("compares the controls when nothing navigated", async () => {
		const made = load();
		const page = { ...pageOf(made), sessions: new Map() };
		const same = (await call(
			made.api.afterAction,
			page,
			'[e1] button "按钮"\nheading "标题"',
			none,
			"r",
			{},
			"",
		)) as unknown as { changed: boolean };
		expect(same.changed).toBe(false);
		const other = (await call(made.api.afterAction, page, "别的", none, "r", {}, "")) as unknown as {
			changed: boolean;
		};
		expect(other.changed).toBe(true);
	});

	it("reads nothing when the page navigated or a dialog is up", async () => {
		const made = load();
		await call(
			made.api.afterAction,
			{ ...pageOf(made), sessions: new Map() },
			"",
			{ ...none, navigated: true },
			"r",
			{},
			"",
		);
		await call(
			made.api.afterAction,
			{ ...pageOf(made), sessions: new Map(), dialog: { type: "alert" } },
			"",
			none,
			"r",
			{},
			"",
		);
		expect(made.count("Accessibility.getFullAXTree")).toBe(0);
	});

	it("takes a new tab into the session", async () => {
		const made = load();
		await call(
			made.api.afterAction,
			{ ...pageOf(made), sessions: new Map() },
			"",
			{ navigated: false, newTab: 9, timedOut: false },
			"r",
			{},
			"run1",
		);
		expect((made.tabs as Record<number, { run: string }>)[9].run).toBe("run1");
		expect(made.saved.length).toBe(1);
	});
});

describe("onRef", () => {
	it("reports a reference that is gone, without acting", async () => {
		const made = load();
		let acted = false;
		const result = await call(made.api.onRef, { tab: 1, ref: "e1" }, async () => {
			acted = true;
		});
		expect(result).toMatchObject({ missing: true });
		expect(acted).toBe(false);
	});

	it("reports a hidden target", async () => {
		const made = load({
			"DOM.getBoxModel": () => {
				throw new Error("no");
			},
		});
		made.api.pageRefs.set(1, new Map([["e1", { target: "", frameId: "F", node: 1, role: "button", name: "按钮" }]]));
		expect(await call(made.api.onRef, { tab: 1, ref: "e1" }, async () => ({ route: "x" }))).toMatchObject({
			missing: true,
			hidden: true,
		});
	});

	it("passes a refusal on, and costs two reads at most for an action", async () => {
		const made = load();
		made.api.pageRefs.set(1, new Map([["e1", { target: "", frameId: "F", node: 1, role: "button", name: "按钮" }]]));
		expect(
			await call(made.api.onRef, { tab: 1, ref: "e1" }, async () => ({ refused: true, reason: "no" })),
		).toMatchObject({ refused: true });
		made.sent.length = 0;
		await call(made.api.onRef, { tab: 1, ref: "e1" }, async () => ({ route: "x" }));
		expect(made.count("Accessibility.getFullAXTree")).toBe(2);
	});
});

describe("OPS", () => {
	const known = { target: "", frameId: "F", node: 1, role: "button", name: "按钮" };
	/** A fake with a reference given out. */
	function ready(replies: Record<string, Reply> = {}, options = {}) {
		const made = load(replies, options);
		made.api.pageRefs.set(1, new Map([["e1", known]]));
		return made;
	}

	it("every page operation refuses a tab that is not ours", async () => {
		const { OPS } = load();
		for (const op of [
			"page_read",
			"page_click",
			"page_hover",
			"page_field",
			"page_type",
			"page_select",
			"page_key",
			"page_scroll",
			"page_drag",
			"page_upload",
			"page_dialog",
			"page_eval",
		])
			await expect(call(OPS[op], { tab: 2 })).rejects.toThrow("not a JiaWriter tab");
	});

	it("page_read gives lines and limits their length", async () => {
		const { OPS } = load();
		expect(await call(OPS.page_read, { tab: 1 })).toMatchObject({ kind: "page", acts: 1, truncated: false });
		expect(await call(OPS.page_read, { tab: 1, limit: 3 })).toMatchObject({ truncated: true, lines: "[e1" });
	});

	it("page_read calls a page of words with no controls an ordinary page", async () => {
		const { OPS } = load({ "Accessibility.getFullAXTree": () => ({ nodes: [axNode("heading", "标题", 1)] }) });
		expect(await call(OPS.page_read, { tab: 1 })).toMatchObject({ kind: "page", acts: 0 });
	});

	it("page_read reports a canvas, and asks Flutter for its tree", async () => {
		const canvas = load({
			"Accessibility.getFullAXTree": () => ({ nodes: [] }),
			"Runtime.evaluate": () => ({ result: { value: "canvas" } }),
		});
		expect(await call(canvas.OPS.page_read, { tab: 1 })).toMatchObject({ kind: "canvas" });
		let reads = 0;
		const flutter = load({
			"Accessibility.getFullAXTree": () => ({ nodes: reads++ ? [axNode("button", "按钮", 1)] : [] }),
			"Runtime.evaluate": () => ({ result: { value: "flutter" } }),
		});
		expect(await call(flutter.OPS.page_read, { tab: 1 })).toMatchObject({ kind: "page", acts: 1 });
	});

	it("page_click activates the reference", async () => {
		const { OPS } = ready();
		expect(await call(OPS.page_click, { tab: 1, ref: "e1" })).toMatchObject({ route: "keyboard" });
	});

	it("page_hover only moves the pointer", async () => {
		const made = ready();
		expect(await call(made.OPS.page_hover, { tab: 1, ref: "e1" })).toMatchObject({ route: "hover" });
		expect(made.count("click")).toBe(0);
		expect(made.count("Enter")).toBe(0);
	});

	it("page_field says what a field is", async () => {
		const { OPS } = ready({ "Runtime.callFunctionOn": () => ({ result: { value: "password" } }) });
		expect(await call(OPS.page_field, { tab: 1, ref: "e1" })).toMatchObject({ type: "password", role: "button" });
		expect(await call(OPS.page_field, { tab: 1, ref: "e9" })).toEqual({ missing: true });
	});

	it("page_type inserts the whole string at once, and reads it back", async () => {
		let texts = 0;
		const made = ready({
			"Input.insertText": () => {
				texts++;
				return {};
			},
			"Runtime.callFunctionOn": (p) => ({
				result: { value: String(p.functionDeclaration).includes("focus") ? { focused: true } : "这段文字" },
			}),
		});
		expect(await call(made.OPS.page_type, { tab: 1, ref: "e1", text: "这段文字" })).toMatchObject({
			route: "insert",
			holds: true,
		});
		expect(texts).toBe(1);
	});

	it("page_type refuses a target that takes no focus", async () => {
		const { OPS } = ready({ "Runtime.callFunctionOn": () => ({ result: { value: { focused: false } } }) });
		expect(await call(OPS.page_type, { tab: 1, ref: "e1", text: "x" })).toMatchObject({
			refused: true,
			reason: "not-focusable",
		});
	});

	it("page_select chooses, or refuses a custom control", async () => {
		const yes = ready({ "Runtime.callFunctionOn": () => ({ result: { value: true } }) });
		expect(await call(yes.OPS.page_select, { tab: 1, ref: "e1", option: "乙" })).toMatchObject({ route: "select" });
		const no = ready({ "Runtime.callFunctionOn": () => ({ result: { value: false } }) });
		expect(await call(no.OPS.page_select, { tab: 1, ref: "e1", option: "乙" })).toMatchObject({ refused: true });
	});

	it("page_key presses the key", async () => {
		const made = ready();
		expect(await call(made.OPS.page_key, { tab: 1, key: "Enter" })).toMatchObject({ route: "key" });
		expect(made.count("Enter")).toBe(1);
	});

	it("page_scroll tells whether anything changed", async () => {
		const { OPS } = ready();
		expect(await call(OPS.page_scroll, { tab: 1, dy: 100 })).toMatchObject({ route: "scroll", changed: false });
		let y = 0;
		const scrolled = ready({
			"Page.getLayoutMetrics": () => ({
				cssVisualViewport: { pageY: y },
				cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
			}),
			"Input.dispatchMouseEvent": () => {
				y = 400;
				return {};
			},
		});
		expect(await call(scrolled.OPS.page_scroll, { tab: 1, dy: 400 })).toMatchObject({ changed: true });
		let reads = 0;
		const moved = ready({
			"Accessibility.getFullAXTree": () => ({ nodes: [axNode("button", `按钮${reads++}`, 1)] }),
		});
		expect(await call(moved.OPS.page_scroll, { tab: 1, ref: "e1" })).toMatchObject({ changed: true });
		expect(await call(moved.OPS.page_scroll, { tab: 1, ref: "e9" })).toMatchObject({ missing: true });
	});

	it("page_drag needs the window in front", async () => {
		const behind = ready();
		expect(await call(behind.OPS.page_drag, { tab: 1, ref: "e1", to: "e1" })).toMatchObject({
			refused: true,
			reason: "needs-front",
		});
		const front = ready({}, { front: true });
		expect(await call(front.OPS.page_drag, { tab: 1, ref: "e1", to: "e1" })).toMatchObject({ route: "drag" });
		expect(await call(front.OPS.page_drag, { tab: 1, ref: "e1", to: "e9" })).toMatchObject({
			refused: true,
			reason: "no-target",
		});
	});

	it("page_upload hands over the paths", async () => {
		let files: unknown;
		const { OPS } = ready({
			"DOM.setFileInputFiles": (p) => {
				files = p.files;
				return {};
			},
		});
		expect(await call(OPS.page_upload, { tab: 1, ref: "e1", files: ["/a"] })).toMatchObject({ route: "upload" });
		expect(files).toEqual(["/a"]);
	});

	it("page_dialog answers through the session that saw it", async () => {
		const made = load();
		expect(await call(made.OPS.page_dialog, { tab: 1 })).toMatchObject({ missing: true, reason: "no-dialog" });
		await call(made.api.withPage, 1, async () =>
			made.emit("Page.javascriptDialogOpening", { type: "alert", message: "m" }),
		);
		expect(await call(made.OPS.page_dialog, { tab: 1, accept: true })).toMatchObject({ route: "dialog" });
		expect(made.count("Page.handleJavaScriptDialog")).toBe(1);
		expect(made.count("detach")).toBe(1);
	});

	it("page_tabs lists this run's open tabs only", async () => {
		const { OPS } = load({}, { tabs: { 1: { run: "a" }, 2: { run: "b" } } });
		expect(await call(OPS.page_tabs, { run: "a" })).toMatchObject({ tabs: [{ tab: 1 }] });
	});

	it("page_capture scales the view down to the edge, and costs one screenshot", async () => {
		let clip: Record<string, number> = {};
		const made = ready({
			"Page.getLayoutMetrics": () => ({
				cssVisualViewport: { pageX: 0, pageY: 300, clientWidth: 2048, clientHeight: 1000 },
			}),
			"Page.captureScreenshot": (p) => {
				clip = p.clip as Record<string, number>;
				return { data: "x" };
			},
		});
		expect(await call(made.OPS.page_capture, { tab: 1, edge: 1024 })).toMatchObject({
			data: "x",
			scale: 0.5,
			y: 300,
		});
		expect(clip).toMatchObject({ y: 300, width: 2048, scale: 0.5 });
		expect(made.count("Page.captureScreenshot")).toBe(1);
	});

	it("page_capture takes one element, without enlarging it", async () => {
		const made = ready({
			"Page.getLayoutMetrics": () => ({
				cssVisualViewport: { pageX: 0, pageY: 100, clientWidth: 800, clientHeight: 600 },
			}),
			"Page.captureScreenshot": () => ({ data: "x" }),
		});
		expect(await call(made.OPS.page_capture, { tab: 1, ref: "e1", edge: 1024 })).toMatchObject({
			scale: 1,
			width: 10,
			y: 100,
		});
		expect(await call(made.OPS.page_capture, { tab: 1, ref: "e9" })).toMatchObject({ missing: true });
	});

	it("page_point activates what is at the point", async () => {
		let asked: unknown;
		const made = ready({
			"Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 0, pageY: 100 } }),
			"DOM.getNodeForLocation": (p) => {
				asked = p;
				return { backendNodeId: 3, frameId: "F" };
			},
		});
		expect(await call(made.OPS.page_point, { tab: 1, x: 50, y: 150 })).toMatchObject({ route: "keyboard" });
		expect(asked).toMatchObject({ x: 50, y: 50 });
	});

	it("page_eval stays in an isolated world unless told, limits the result, and reports errors", async () => {
		let context: unknown;
		const made = load({
			"Runtime.evaluate": (p) => {
				context = p.contextId;
				return { result: { value: "x".repeat(30000) } };
			},
		});
		expect(await call(made.OPS.page_eval, { tab: 1, code: "1" })).toMatchObject({ truncated: true });
		expect(context).toBe(5);
		await call(made.OPS.page_eval, { tab: 1, code: "1", main: true });
		expect(context).toBeUndefined();
		const bad = load({ "Runtime.evaluate": () => ({ result: {}, exceptionDetails: { text: "boom" } }) });
		expect(await call(bad.OPS.page_eval, { tab: 1, code: "x" })).toEqual({ error: "boom" });
	});
});
