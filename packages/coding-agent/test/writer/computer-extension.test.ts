// The computer tool's extension (src/extensions/writer-computer/index.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import writerComputerExtension, {
	computerSetup,
	doctorLines,
	factLines,
	runCommand,
} from "../../src/extensions/writer-computer/index.ts";
import { EXTENSION_VERSION } from "../../src/writer/browser/bridge.ts";

let dir: string;
const before = process.env.JW_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-ce-"));
	process.env.JW_DIR = dir;
});
afterEach(() => {
	if (before === undefined) delete process.env.JW_DIR;
	else process.env.JW_DIR = before;
	delete process.env.JW_COMPUTER_DRIVER;
	rmSync(dir, { recursive: true });
});

describe("runCommand", () => {
	it("gives the output and the exit code", async () => {
		expect(await runCommand("node", ["-e", "console.log('hi')"])).toEqual({ code: 0, stdout: "hi\n" });
		expect((await runCommand("node", ["-e", "process.exit(3)"])).code).toBe(3);
		expect((await runCommand("/no/such/program", [])).code).not.toBe(0);
	});
});

describe("factLines", () => {
	const facts = { ocr: false, driver: false, mode: "auto" };
	it("gives the next step for each thing that is missing", () => {
		const text = factLines(facts).join("\n");
		expect(text).toContain("/browser");
		expect(text).toContain("/jw computer");
		expect(text).toContain("JW_URL");
	});
	it("tells an old extension from a current one", () => {
		expect(factLines({ ...facts, extension: "1.0.0" }).join("\n")).toContain("chrome://extensions");
		expect(factLines({ ...facts, extension: EXTENSION_VERSION }).join("\n")).toContain(EXTENSION_VERSION);
	});
});

describe("doctorLines", () => {
	it("works with nothing set up, and connects to nothing", async () => {
		const lines = await doctorLines();
		expect(lines.length).toBeGreaterThan(5);
	});
});

describe("computerSetup", () => {
	it("runs through the driver named, with no model", async () => {
		process.env.JW_COMPUTER_DRIVER = process.execPath;
		const notes: string[] = [];
		const ctx = {
			hasUI: false,
			ui: { notify: (text: string) => void notes.push(text) },
		} as unknown as ExtensionCommandContext;
		// Only the install part: the system's own steps would open System Settings on a Mac, so they are
		// tested with the machine replaced (computer-setup.test.ts). The driver named is found, so nothing is fetched.
		expect(await computerSetup(ctx, true)).toBe("limited");
		expect(notes).toEqual([]);
	}, 30000);
});

// session_start runs settleTool (src/extensions/writer-computer/index.ts): the cases below are its tests.
describe("writerComputerExtension", () => {
	/** The extension, with what it registers kept. */
	function loaded(active: string[]) {
		const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
		const tools: { name: string; defaultActive?: boolean; description: string }[] = [];
		const entries: unknown[] = [];
		const set: string[][] = [];
		const on = (name: string, fn: (e: unknown, c: unknown) => unknown) => {
			handlers[name] = fn;
		};
		const pi = {
			on,
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => set.push(names),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		};
		writerComputerExtension(pi as unknown as ExtensionAPI);
		const ctx = { sessionManager: { getEntries: () => entries } };
		return { handlers, tools, set, entries, ctx };
	}

	it("keeps its description short, and costs nothing unless installed", () => {
		const { tools, handlers, set, ctx, entries } = loaded(["search_web"]);
		expect(tools[0].description.length).toBeLessThanOrEqual(500);
		expect(tools[0].defaultActive).toBe(false);
		handlers.session_start({}, ctx);
		expect(set.length).toBe(0);
		expect(entries).toEqual([{ type: "custom", customType: "jiawriter-computer-tool", data: false }]);
	});

	it("joins a conversation when installed, and a resumed one keeps its choice", () => {
		process.env.JW_COMPUTER_DRIVER = process.execPath;
		const { handlers, set, ctx } = loaded(["search_web"]);
		handlers.session_start({}, ctx);
		expect(set[0]).toContain("computer");
		delete process.env.JW_COMPUTER_DRIVER;
		handlers.session_start({}, ctx);
		expect(set.length).toBe(2);
	});

	it("respects an allowlist", () => {
		process.env.JW_COMPUTER_DRIVER = process.execPath;
		const { handlers, set, ctx } = loaded(["read"]);
		handlers.session_start({}, ctx);
		expect(set.length).toBe(0);
	});
});
