// Functional tests: a draft is changed in place (the user, 2026-11-05). The model is told before it writes,
// through what it reads when it picks a tool; a whole text it has already produced is never turned down.

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
// What the model reads when it picks a tool.
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
// Extension under test.
import writerDocsExtension from "../../src/extensions/writer-docs/index.ts";
// Harness with the faux provider.
import { createHarness, type Harness } from "../suite/harness.ts";

/** One write call as a model reply. */
const write = (path: string, content: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });

describe("guidance before writing", () => {
	it("tells the model in the tool descriptions that an existing file is changed with edit", () => {
		expect(createWriteToolDefinition("/tmp").description).toMatch(/already exists is changed with edit/);
		expect(createWriteToolDefinition("/tmp").description).not.toMatch(/overwrites/);
		expect(createEditToolDefinition("/tmp").description).toMatch(/however large the change/);
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

	it("never turns down a text the model has already produced", async () => {
		harness?.setResponses([write("初稿.md", "第二版"), fauxAssistantMessage("好")]);
		await harness?.session.prompt("第二段改短");
		const failed = harness?.session.messages
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as { isError?: boolean }).isError);
		expect(failed).toEqual([false, false]);
		expect(readFileSync(join(harness?.tempDir ?? "", "初稿.md"), "utf-8")).toBe("第二版");
	});
});
