// Tests for going back: the snapshot store (src/writer/rewind) and the extension's /rewind and draft_restore
// over the real write and edit tools.

// Temp files.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Faux provider helpers.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension under test.
import writerRewindExtension, { userTurns } from "../../src/extensions/writer-rewind/index.ts";
// Functions under test.
import {
	readSnapshots,
	restoreSnapshot,
	storeDir,
	takeSnapshot,
	undoTargets,
	versionsOf,
} from "../../src/writer/rewind/rewind.ts";
// Harness with the faux provider.
import { createHarness, type Harness } from "../suite/harness.ts";

// Temp folder of each test.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-rewind-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("snapshot store", () => {
	it("gives each working folder its own store", () => {
		expect(storeDir("/a", "/w1")).not.toBe(storeDir("/a", "/w2"));
		expect(storeDir("/a", "/w1")).toBe(storeDir("/a", "/w1"));
	});

	it("saves a file once per user message, and records that a file did not exist", () => {
		const store = join(dir, "s");
		const file = join(dir, "a.md");
		expect(takeSnapshot(store, file, "u1")?.blob).toBeNull();
		expect(takeSnapshot(store, file, "u1")).toBeUndefined();
		writeFileSync(file, "一");
		expect(takeSnapshot(store, file, "u2")?.size).toBe(3);
		expect(readSnapshots(store).map((s) => s.user)).toEqual(["u1", "u2"]);
	});

	it("skips a line cut off by a crash", () => {
		const store = join(dir, "s");
		takeSnapshot(store, join(dir, "a.md"), "u1");
		writeFileSync(join(store, "index.jsonl"), `${readFileSync(join(store, "index.jsonl"), "utf-8")}{"n":`);
		expect(readSnapshots(store)).toHaveLength(1);
	});

	it("finds each file's earliest state among the messages undone", () => {
		const s = (n: number, file: string, user: string) => ({ n, file, user, blob: null, at: 0, size: 0 });
		const all = [s(1, "a", "u1"), s(2, "a", "u2"), s(3, "b", "u2"), s(4, "a", "u3")];
		expect(undoTargets(all, new Set(["u2", "u3"])).map((x) => x.n)).toEqual([2, 3]);
		expect(undoTargets(all, new Set(["u9"]))).toEqual([]);
	});

	it("restores content, removes a file that did not exist, and can undo the restore", () => {
		const store = join(dir, "s");
		const file = join(dir, "a.md");
		const created = takeSnapshot(store, file, "u1");
		writeFileSync(file, "一");
		const first = takeSnapshot(store, file, "u2");
		writeFileSync(file, "二");
		restoreSnapshot(store, first as NonNullable<typeof first>);
		expect(readFileSync(file, "utf-8")).toBe("一");
		// What was there before the restore is a version now.
		const versions = versionsOf(readSnapshots(store), file);
		expect(versions.map((v) => v.size)).toEqual([3, 3]);
		restoreSnapshot(store, versions[1]);
		expect(readFileSync(file, "utf-8")).toBe("二");
		restoreSnapshot(store, created as NonNullable<typeof created>);
		expect(existsSync(file)).toBe(false);
	});
});

describe("going back in a session", () => {
	let harness: Harness | undefined;
	beforeEach(async () => {
		vi.stubEnv("JW_DIR", join(dir, "agent"));
		vi.stubEnv("JW_AUTO_EXPORT", "off");
		vi.stubEnv("JW_LANG", "zh");
		harness = await createHarness({
			extensionFactories: [writerRewindExtension],
			initialActiveToolNames: ["write", "edit", "draft_restore"],
		});
		// Two turns: create the draft, then edit it.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "稿.md", content: "第一版" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("好"),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "稿.md", edits: [{ oldText: "第一版", newText: "第二版" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("改好了"),
		]);
		await harness.session.prompt("写一篇");
		await harness.session.prompt("改一下");
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
	});

	/** The draft's path and text. */
	const path = () => join(harness?.tempDir ?? "", "稿.md");
	const text = () => readFileSync(path(), "utf-8");

	/** Run /rewind with scripted menu answers; returns what it told the user and put into the editor. */
	async function rewind(answers: (labels: string[]) => string | undefined, idle = true) {
		const h = harness as Harness;
		const notes: string[] = [];
		const editor: string[] = [];
		const navigated: string[] = [];
		const command = h.session.extensionRunner?.getCommand("rewind");
		await command?.handler("", {
			cwd: h.tempDir,
			sessionManager: h.sessionManager,
			isIdle: () => idle,
			navigateTree: async (id: string) => {
				navigated.push(id);
				await h.session.navigateTree(id, { summarize: false });
				return { cancelled: false };
			},
			ui: {
				select: async (_title: string, labels: string[]) => answers(labels),
				notify: (m: string) => notes.push(m),
				setEditorText: (t: string) => editor.push(t),
			},
		} as never);
		return { notes, editor, navigated };
	}

	it("goes back with the conversation and the files, and the message returns to the input box", async () => {
		const r = await rewind((labels) =>
			labels[0].startsWith("2.") ? labels[0] : labels.find((l) => l.includes("一起")),
		);
		expect(text()).toBe("第一版");
		expect(r.editor).toEqual(["改一下"]);
		// Only the first turn is left.
		expect(harness?.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(r.notes[0]).toContain("1");
	});

	it("goes back to the very first message: the draft is gone", async () => {
		await rewind((labels) => labels.find((l) => l.startsWith("1.")) ?? labels.find((l) => l.includes("一起")));
		expect(existsSync(path())).toBe(false);
		expect(harness?.session.messages.filter((m) => m.role === "user")).toHaveLength(0);
	});

	it("moves only the conversation or only the files when asked", async () => {
		await rewind((labels) =>
			labels[0].startsWith("2.") ? labels[0] : labels.find((l) => l.startsWith("只退回文件")),
		);
		expect(text()).toBe("第一版");
		expect(harness?.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
		// The file was restored, so the undo of it is a snapshot too; now the conversation alone.
		writeFileSync(path(), "手改");
		await rewind((labels) =>
			labels[0].startsWith("2.") ? labels[0] : labels.find((l) => l.startsWith("只退回对话")),
		);
		expect(text()).toBe("手改");
		expect(harness?.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("changes nothing when the menu is left, or during a reply", async () => {
		await rewind(() => undefined);
		expect(text()).toBe("第二版");
		const busy = await rewind(() => {
			throw new Error("no menu during a reply");
		}, false);
		expect(busy.notes[0]).toContain("Esc");
	});

	it("lists and restores a version through draft_restore in conversation", async () => {
		const h = harness as Harness;
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_restore", { path: "稿.md" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_restore", { path: "稿.md", version: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已退回"),
		]);
		await h.session.prompt("退回上一版");
		expect(text()).toBe("第一版");
		const results = h.session.messages.filter((m) => m.role === "toolResult").slice(-2);
		expect(JSON.stringify(results[0])).toContain("版本 1");
		expect(JSON.stringify(results[1])).toContain("已恢复到版本 1");
	});

	it("reads the user messages of the active branch", () => {
		const turns = userTurns({ sessionManager: harness?.sessionManager } as never);
		expect(turns.map((t) => t.text)).toEqual(["写一篇", "改一下"]);
	});
});
