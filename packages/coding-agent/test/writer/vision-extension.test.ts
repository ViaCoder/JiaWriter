// The vision extension (src/extensions/writer-vision/index.ts): pictures from files, and finding out about an upstream.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import writerVisionExtension, {
	findSupport,
	isPicturePath,
	listSupport,
	probeSupport,
	sessionVision,
	supportFile,
} from "../../src/extensions/writer-vision/index.ts";
import { readSupport, sharedLedger } from "../../src/writer/vision.ts";

const model = {
	id: "m",
	baseUrl: "https://relay.example.com/v1",
	provider: "other",
	input: ["text"],
	api: "openai-responses",
} as unknown as Model<Api>;
let dir: string;
const before = process.env.JW_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-ve-"));
	process.env.JW_DIR = dir;
});
afterEach(() => {
	if (before === undefined) delete process.env.JW_DIR;
	else process.env.JW_DIR = before;
	delete process.env.JW_IMAGE;
	vi.unstubAllGlobals();
	sharedLedger().reset();
	rmSync(dir, { recursive: true });
});

describe("isPicturePath", () => {
	it("knows pictures by their ending", () => {
		expect(isPicturePath("a/b.PNG")).toBe(true);
		expect(isPicturePath("a.webp")).toBe(true);
		expect(isPicturePath("a.md")).toBe(false);
	});
});

describe("supportFile", () => {
	it("lives in the agent folder", () => {
		expect(supportFile()).toBe(join(dir, "vision.json"));
	});
});

describe("listSupport", () => {
	it("reads the upstream's list, and says nothing on an error", async () => {
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "m", architecture: { input_modalities: ["image"] } }] }),
		}));
		expect(await listSupport(model)).toBe(true);
		vi.stubGlobal("fetch", async () => ({ ok: false }));
		expect(await listSupport(model)).toBeUndefined();
	});
});

describe("probeSupport", () => {
	it("gives up quietly on a bad address, as not knowing", async () => {
		await expect(probeSupport({ ...model, baseUrl: "http://127.0.0.1:1/v1" })).resolves.toBeUndefined();
	});
});

describe("findSupport", () => {
	const ctx = (m: unknown) => ({ model: m }) as unknown as ExtensionContext;
	const pi = { registerProvider: () => undefined } as unknown as ExtensionAPI;

	it("needs a model, and believes a built-in model's declaration", async () => {
		expect(await findSupport(pi, ctx(undefined))).toBe(false);
		expect(await findSupport(pi, ctx({ ...model, input: ["text", "image"] }))).toBe(true);
		expect(await findSupport(pi, ctx(model))).toBe(false);
	});

	it("remembers what it found", async () => {
		process.env.JW_IMAGE = "off";
		expect(await findSupport(pi, ctx({ ...model, provider: "jw" }))).toBe(false);
		expect(Object.values(readSupport(supportFile()))).toEqual([false]);
	});
});

describe("sessionVision", () => {
	it("gives the limits of the session", () => {
		const vision = sessionVision({} as ExtensionAPI, {} as ExtensionContext);
		expect(vision.edge).toBe(1024);
		expect(vision.ledger).toBe(sharedLedger());
	});
});

describe("writerVisionExtension", () => {
	/** The extension's handlers. */
	function loaded() {
		const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
		const on = (name: string, fn: (e: unknown, c: unknown) => unknown) => {
			handlers[name] = fn;
		};
		writerVisionExtension({ on, registerProvider: () => undefined } as unknown as ExtensionAPI);
		return handlers;
	}
	const reading = { toolName: "read", input: { path: "/a/图.png" } };
	const ctx = (hasUI: boolean, answer = true) => ({
		hasUI,
		model: { input: ["text", "image"] },
		ui: { confirm: async () => answer },
	});

	it("holds a picture from a file to the same permission", async () => {
		const handlers = loaded();
		expect(await handlers.tool_call(reading, ctx(false))).toMatchObject({ block: true });
		expect(await handlers.tool_call(reading, ctx(true, false))).toMatchObject({ block: true });
		expect(await handlers.tool_call(reading, ctx(true))).toBeUndefined();
	});

	it("holds it to the same limit, and a new message lifts the turn's", async () => {
		const handlers = loaded();
		await handlers.tool_call(reading, ctx(true));
		expect(await handlers.tool_call(reading, ctx(true))).toMatchObject({ block: true });
		handlers.before_agent_start({}, {});
		expect(await handlers.tool_call(reading, ctx(true))).toBeUndefined();
	});

	it("leaves everything else alone", async () => {
		const handlers = loaded();
		expect(await handlers.tool_call({ toolName: "read", input: { path: "a.md" } }, ctx(false))).toBeUndefined();
		expect(await handlers.tool_call(reading, { hasUI: false, model: { input: ["text"] } })).toBeUndefined();
	});
});
