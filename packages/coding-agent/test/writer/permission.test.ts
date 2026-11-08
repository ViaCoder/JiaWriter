// The permission modes (src/writer/permission.ts): the table, the rules and the gate.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { setPermission } from "../../src/extensions/writer-ui/index.ts";
import { setUiLang, uiSettingsPath } from "../../src/writer/i18n/index.ts";
import {
	createPermissionGate,
	isSecretField,
	needsAsking,
	type PermissionMode,
	parsePermissionMode,
	permissionMode,
	type Risk,
	riskOfLabel,
	savedPermissionMode,
	savePermissionMode,
} from "../../src/writer/permission.ts";

let dir: string;
const before = process.env.JW_DIR;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-permission-"));
	process.env.JW_DIR = dir;
});
afterEach(() => {
	if (before === undefined) delete process.env.JW_DIR;
	else process.env.JW_DIR = before;
	rmSync(dir, { recursive: true });
});

/** An interface that answers and counts. */
function ui(answer: boolean, hasUI = true) {
	const asked: string[] = [];
	return {
		asked,
		hasUI,
		ui: {
			confirm: async (title: string) => {
				asked.push(title);
				return answer;
			},
		},
	};
}

describe("parsePermissionMode", () => {
	it("takes the three modes in any case, and nothing else", () => {
		expect(parsePermissionMode(" Bypass ")).toBe("bypass");
		expect(parsePermissionMode("manual")).toBe("manual");
		expect(parsePermissionMode("off")).toBeUndefined();
		expect(parsePermissionMode(undefined)).toBeUndefined();
	});
});

describe("permissionMode", () => {
	it("is auto by default, then the saved choice, and JW_PERMISSION wins", () => {
		expect(permissionMode({})).toBe("auto");
		savePermissionMode("manual");
		expect(savedPermissionMode()).toBe("manual");
		expect(permissionMode({})).toBe("manual");
		expect(permissionMode({ JW_PERMISSION: "bypass" })).toBe("bypass");
		expect(permissionMode({ JW_PERMISSION: "nonsense" })).toBe("manual");
	});

	it("savePermissionMode and setUiLang keep each other's setting", () => {
		setUiLang("en");
		savePermissionMode("bypass");
		setUiLang("zh");
		expect(JSON.parse(readFileSync(uiSettingsPath(), "utf-8"))).toEqual({ lang: "zh", permission: "bypass" });
	});

	it("savedPermissionMode ignores a broken file", () => {
		writeFileSync(uiSettingsPath(), "not json");
		expect(savedPermissionMode()).toBeUndefined();
	});
});

describe("needsAsking", () => {
	// Mode, risk, already allowed, whether it asks: the whole table.
	const table: [PermissionMode, Risk, boolean, boolean][] = [
		["manual", "read", false, true],
		["manual", "read", true, false],
		["manual", "act", false, true],
		["manual", "act", true, true],
		["manual", "high", true, true],
		["auto", "read", false, false],
		["auto", "act", false, true],
		["auto", "act", true, false],
		["auto", "high", false, true],
		["auto", "high", true, true],
		["bypass", "read", false, false],
		["bypass", "act", false, false],
		["bypass", "high", false, false],
	];
	it.each(table)("%s %s seen=%s", (mode, risk, seen, asks) => {
		expect(needsAsking(mode, risk, seen)).toBe(asks);
	});
});

describe("riskOfLabel", () => {
	it("marks labels that send, delete or pay", () => {
		for (const label of ["提交", "立即支付", "Delete file", "SEND", "Check out"]) {
			expect(riskOfLabel(label)).toBe(label === "Check out" ? "act" : "high");
		}
		expect(riskOfLabel("下一页")).toBe("act");
		expect(riskOfLabel("Posts")).toBe("act");
	});
});

describe("isSecretField", () => {
	it("knows password fields", () => {
		expect(isSecretField("textbox", "password")).toBe(true);
		expect(isSecretField("AXSecureTextField", "")).toBe(true);
		expect(isSecretField("textbox", "text")).toBe(false);
	});
});

describe("createPermissionGate", () => {
	const request = { risk: "act" as const, scope: "example.com", title: "点击？", detail: "按钮" };

	it("asks once per scope in auto, and forgets on reset", async () => {
		const gate = createPermissionGate({ JW_PERMISSION: "auto" });
		const yes = ui(true);
		expect(await gate.check(yes, request)).toBe("");
		expect(await gate.check(yes, request)).toBe("");
		expect(yes.asked.length).toBe(1);
		await gate.check(yes, { ...request, scope: "other.example.com" });
		expect(yes.asked.length).toBe(2);
		gate.reset();
		await gate.check(yes, request);
		expect(yes.asked.length).toBe(3);
	});

	it("stops on no, and keeps asking", async () => {
		const gate = createPermissionGate({ JW_PERMISSION: "auto" });
		const no = ui(false);
		expect(await gate.check(no, request)).toBe("declined");
		expect(await gate.check(no, request)).toBe("declined");
		expect(no.asked.length).toBe(2);
	});

	it("turns a question into a refusal when nobody can answer", async () => {
		const gate = createPermissionGate({ JW_PERMISSION: "auto" });
		expect(await gate.check(ui(true, false), request)).toBe("no-user");
	});

	it("never asks in bypass, even with nobody there", async () => {
		const gate = createPermissionGate({ JW_PERMISSION: "bypass" });
		const quiet = ui(false, false);
		expect(await gate.check(quiet, { ...request, risk: "high" })).toBe("");
		expect(quiet.asked.length).toBe(0);
	});
});

describe("setPermission", () => {
	/** A command context that records notes and answers a choice. */
	function context(choice?: string, hasUI = true) {
		const notes: [string, string][] = [];
		return {
			notes,
			ctx: {
				hasUI,
				ui: { select: async () => choice, notify: (text: string, kind: string) => void notes.push([text, kind]) },
			} as unknown as ExtensionCommandContext,
		};
	}

	it("saves the mode named", async () => {
		const { ctx, notes } = context();
		await setPermission(" bypass", ctx);
		expect(savedPermissionMode()).toBe("bypass");
		expect(notes[0][1]).toBe("info");
	});

	it("offers a choice when none is named, and does nothing when dismissed", async () => {
		const chosen = context("manual");
		await setPermission("", chosen.ctx);
		expect(savedPermissionMode()).toBe("manual");
		const dismissed = context(undefined);
		await setPermission("", dismissed.ctx);
		expect(dismissed.notes.length).toBe(0);
	});

	it("refuses anything else", async () => {
		const { ctx, notes } = context();
		await setPermission("always", ctx);
		expect(notes[0][1]).toBe("error");
		expect(savedPermissionMode()).toBeUndefined();
	});

	it("warns when the environment wins", async () => {
		process.env.JW_PERMISSION = "auto";
		const { ctx, notes } = context();
		await setPermission("manual", ctx);
		delete process.env.JW_PERMISSION;
		expect(notes[0][1]).toBe("warning");
	});
});
