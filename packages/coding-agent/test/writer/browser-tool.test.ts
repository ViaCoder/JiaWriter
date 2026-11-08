// The browser tool's extension (src/extensions/writer-browser/index.ts): whether it is there, and its results.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerBrowserExtension, {
	browserWanted,
	knownChoice,
	resultContent,
	resultText,
} from "../../src/extensions/writer-browser/index.ts";
import { bridgePresent } from "../../src/writer/browser/bridge.ts";
import { outcome } from "../../src/writer/protocol.ts";

describe("browserWanted", () => {
	it("takes JW_BROWSER first, else whether the extension answers", async () => {
		const answers = async () => true;
		const silent = async () => false;
		expect(await browserWanted({ JW_BROWSER: "on" }, silent)).toBe(true);
		expect(await browserWanted({ JW_BROWSER: "off" }, answers)).toBe(false);
		expect(await browserWanted({}, answers)).toBe(true);
		expect(await browserWanted({}, silent)).toBe(false);
	});
});

describe("resultText", () => {
	it("moves the page's lines after the JSON", () => {
		const text = resultText(outcome("confirmed", "read", "model", "", { url: "u", lines: "[e1] link" }));
		expect(text.split("\n")[1]).toBe("[e1] link");
		expect(JSON.parse(text.split("\n")[0]).data).toEqual({ url: "u" });
	});

	it("gives results without data as they are", () => {
		expect(JSON.parse(resultText(outcome("refused", "x", "user", "why"))).reason).toBe("why");
	});
});

describe("knownChoice", () => {
	it("gives the choice a conversation made, even when it was no", () => {
		expect(knownChoice([])).toBeUndefined();
		expect(knownChoice([{ type: "custom", customType: "jiawriter-browser-tool", data: false }])).toBe(false);
		expect(knownChoice([{ type: "custom", customType: "other", data: true }])).toBeUndefined();
	});
});

describe("bridgePresent", () => {
	it("looks for the socket or the port file, without connecting", () => {
		const dir = mkdtempSync(join(tmpdir(), "jw-bridge-"));
		const path = join(dir, "bridge.sock");
		expect(bridgePresent({ kind: "unix", path })).toBe(false);
		expect(bridgePresent({ kind: "tcp", file: path })).toBe(false);
		writeFileSync(path, "");
		expect(bridgePresent({ kind: "unix", path })).toBe(true);
		expect(bridgePresent({ kind: "tcp", file: path })).toBe(true);
		rmSync(dir, { recursive: true });
	});
});

describe("the tool's description", () => {
	it("stays under its budget", () => {
		const tools: { name: string; description: string }[] = [];
		writerBrowserExtension({
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			on: () => undefined,
		} as unknown as ExtensionAPI);
		expect(tools[0].description.length).toBeLessThanOrEqual(600);
	});
});

describe("resultContent", () => {
	it("gives the picture as an image block, and keeps it out of the words", () => {
		const picture = { data: "UElD", mimeType: "image/jpeg", detail: "low" };
		const [text, image] = resultContent(outcome("confirmed", "look", "model", "", { size: "1×1", picture }));
		expect(text).toMatchObject({ type: "text" });
		expect(JSON.stringify(text)).not.toContain("UElD");
		expect(image).toMatchObject({ type: "image", data: "UElD", detail: "low" });
		expect(resultContent(outcome("confirmed", "read", "model")).length).toBe(1);
	});
});

// settleTool (src/extensions/writer-browser/index.ts), through session_start: whether a conversation has the tool,
// settled once and kept, so the tool set never changes inside a conversation.
describe("settleTool", () => {
	afterEach(() => vi.unstubAllEnvs());

	/** The extension with a given tool set and session entries; what it sets and records is kept. */
	function started(active: string[], entries: unknown[]) {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const set: string[][] = [];
		const named: Record<string, unknown> = {
			on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = fn;
			},
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => set.push(names),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		};
		// Anything else registered is ignored.
		const pi = new Proxy(named, { get: (target, key: string) => target[key] ?? (() => undefined) });
		writerBrowserExtension(pi as unknown as ExtensionAPI);
		const ctx = { hasUI: false, sessionManager: { getEntries: () => entries } };
		return { start: () => handlers.session_start({}, ctx) as Promise<void>, set, entries };
	}

	it("joins a new conversation when asked to, and records the choice", async () => {
		vi.stubEnv("JW_BROWSER", "on");
		const { start, set, entries } = started(["read", "search_web"], []);
		await start();
		expect(set).toEqual([["read", "search_web", "browser"]]);
		expect(entries).toEqual([{ type: "custom", customType: "jiawriter-browser-tool", data: true }]);
	});

	it("stays out when turned off", async () => {
		vi.stubEnv("JW_BROWSER", "off");
		const { start, set, entries } = started(["search_web"], []);
		await start();
		expect(set).toEqual([]);
		expect(entries).toEqual([{ type: "custom", customType: "jiawriter-browser-tool", data: false }]);
	});

	it("keeps what a resumed conversation chose, whatever the setting is now", async () => {
		vi.stubEnv("JW_BROWSER", "on");
		const { start, set, entries } = started(
			["search_web"],
			[{ type: "custom", customType: "jiawriter-browser-tool", data: false }],
		);
		await start();
		expect(set).toEqual([]);
		expect(entries.length).toBe(1);
	});

	it("leaves an allowlist alone", async () => {
		vi.stubEnv("JW_BROWSER", "on");
		const { start, set, entries } = started(["read"], []);
		await start();
		expect([set, entries]).toEqual([[], []]);
	});
});
