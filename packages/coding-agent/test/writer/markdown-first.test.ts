// Functional tests: a draft is changed in place (the user, 2026-11-05). The write tool may create a draft,
// but replacing one goes through only when the user asked for a rewrite.

// Temp files.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Faux provider helpers.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Extension under test.
import writerDocsExtension from "../../src/extensions/writer-docs/index.ts";
// The word check.
import { asksWholeRewrite } from "../../src/writer/docs/auto.ts";
// Harness with the faux provider.
import { createHarness, type Harness } from "../suite/harness.ts";

/** One write call as a model reply. */
const write = (path: string, content: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });

describe("asksWholeRewrite", () => {
	it("reads the words of a whole rewrite", () => {
		for (const text of ["全文重写一遍", "请重新写", "Rewrite it", "推倒重来"])
			expect(asksWholeRewrite(text)).toBe(true);
		for (const text of ["第二段改短", "把数字改一下", "补一个案例"]) expect(asksWholeRewrite(text)).toBe(false);
	});
});

describe("write on a draft", () => {
	let harness: Harness | undefined;
	let agentDir = "";
	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "jw-md-"));
		vi.stubEnv("JW_DIR", agentDir);
		vi.stubEnv("JW_AUTO_EXPORT", "off");
		vi.stubEnv("JW_LANG", "zh");
		harness = await createHarness({
			extensionFactories: [writerDocsExtension],
			initialActiveToolNames: ["write", "edit"],
		});
		harness.setResponses([write("初稿.md", "第一版"), fauxAssistantMessage("好")]);
		await harness.session.prompt("写一篇");
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** The draft's text. */
	const draft = () => readFileSync(join(harness?.tempDir ?? "", "初稿.md"), "utf-8");
	/** Whether the latest tool result failed. */
	const lastFailed = () =>
		harness?.session.messages.filter((m) => m.role === "toolResult").map((m) => (m as { isError?: boolean }).isError);

	it("refuses to replace a draft, once, and says to use edit", async () => {
		harness?.setResponses([write("初稿.md", "第二版"), write("初稿.md", "第三版"), fauxAssistantMessage("好")]);
		await harness?.session.prompt("第二段改短");
		// The first attempt is refused, the second goes through.
		expect(lastFailed()).toEqual([false, true, false]);
		expect(draft()).toBe("第三版");
		const refused = harness?.session.messages.filter((m) => m.role === "toolResult")[1];
		expect(JSON.stringify(refused)).toContain("edit");
	});

	it("lets a rewrite the user asked for through at once", async () => {
		harness?.setResponses([write("初稿.md", "第二版"), fauxAssistantMessage("好")]);
		await harness?.session.prompt("全文重写一遍");
		expect(draft()).toBe("第二版");
	});

	it("leaves new files, notes and outlines alone", async () => {
		harness?.setResponses([
			write("第二篇.md", "新稿"),
			write("大纲.md", "一"),
			write("大纲.md", "二"),
			fauxAssistantMessage("好"),
		]);
		await harness?.session.prompt("再写一篇");
		expect(lastFailed()).toEqual([false, false, false, false]);
	});
});
