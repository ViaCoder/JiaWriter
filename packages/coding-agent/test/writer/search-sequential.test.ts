// Functional test: several web_search calls in one model message run one at a time (the user, 2026-11-05:
// AnySearch fails on parallel requests).

// Temp files.
import { mkdtempSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Faux provider helpers.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// Test API.
import { afterEach, describe, expect, it, vi } from "vitest";
// Extension under test.
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
// Harness with the faux provider.
import { createHarness, type Harness } from "../suite/harness.ts";

describe("web_search and web_fetch one at a time", () => {
	let harness: Harness | undefined;
	let dir = "";
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	it("never has two AnySearch requests open, with a gap between them", async () => {
		dir = mkdtempSync(join(tmpdir(), "jw-seq-"));
		vi.stubEnv("JW_SEARCH", "anysearch");
		vi.stubEnv("JW_DIR", join(dir, "agent"));
		// Fake AnySearch: counts open requests and their start times.
		let open = 0;
		let most = 0;
		const starts: number[] = [];
		vi.stubGlobal("fetch", async () => {
			open++;
			most = Math.max(most, open);
			starts.push(Date.now());
			await new Promise((resolve) => setTimeout(resolve, 30));
			open--;
			return new Response(
				JSON.stringify({ code: 0, data: { results: [{ title: "标题", url: "https://a.example/1" }] } }),
			);
		});
		harness = await createHarness({
			extensionFactories: [writerSearchExtension],
			initialActiveToolNames: ["web_search"],
		});
		harness.setResponses([
			fauxAssistantMessage(
				["甲", "乙", "丙"].map((query) => fauxToolCall("web_search", { query })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("好了"),
		]);
		await harness.session.prompt("查资料");
		expect(starts).toHaveLength(3);
		expect(most).toBe(1);
		// Each call ends before the next begins (the gap alone would also keep requests apart).
		const order = harness.events.flatMap((e) =>
			e.type === "tool_execution_start" ? ["start"] : e.type === "tool_execution_end" ? ["end"] : [],
		);
		expect(order).toEqual(["start", "end", "start", "end", "start", "end"]);
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
	}, 20_000);
});
