// Compaction for writing: settings scaled to the window, archived results as one line, state from the disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactionPreparation, CompactionResult } from "../../src/core/compaction/compaction.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import {
	prepareForSummary,
	slimForSummary,
	withWritingState,
	writerCompactionSettings,
	writingState,
} from "../../src/writer/compact/state.ts";
import { archivePage, archiveSearch } from "../../src/writer/topic/topic.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A session entry holding a message. */
const entry = (message: unknown) => ({ type: "message", message }) as unknown as SessionEntry;
/** A tool result. */
const toolResult = (toolName: string, text: string, toolCallId = "c") =>
	({
		role: "toolResult",
		toolName,
		toolCallId,
		content: [{ type: "text", text }],
		isError: false,
	}) as unknown as AgentMessage;

describe("writerCompactionSettings", () => {
	const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

	it("starts at 80% of the window and keeps 15%", () => {
		expect(writerCompactionSettings(settings, 1_000_000)).toMatchObject({
			reserveTokens: 200_000,
			keepRecentTokens: 150_000,
		});
	});

	it("keeps a larger configured value, and all of it for an unknown window", () => {
		expect(writerCompactionSettings(settings, 50_000)).toMatchObject({
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
		expect(writerCompactionSettings(settings, 0)).toBe(settings);
	});
});

describe("slimForSummary", () => {
	it("turns archived results into their archive line and leaves the rest", () => {
		const page = `${"正文".repeat(5000)}\n已归档：/t/网页/002-新闻.md`;
		const assistant = { role: "assistant", content: [{ type: "text", text: "好" }] } as unknown as AgentMessage;
		const [a, b, c] = slimForSummary([
			toolResult("fetch_web", page),
			assistant,
			toolResult("style_check", "问题列表"),
		]);
		expect(JSON.stringify(a)).toContain("已归档：/t/网页/002-新闻.md");
		expect(JSON.stringify(a)).not.toContain("正文");
		expect(b).toBe(assistant);
		expect(JSON.stringify(c)).toContain("问题列表");
	});

	it("names the file of a read, and cuts a result with no archive line", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "稿件/初稿.md" } }],
		} as unknown as AgentMessage;
		const out = slimForSummary([
			call,
			toolResult("read", "全文".repeat(500), "r1"),
			toolResult("search_web", "长".repeat(900)),
		]);
		expect(JSON.stringify(out[1])).toContain("Read 稿件/初稿.md");
		expect(JSON.stringify(out[1])).not.toContain("全文");
		expect(JSON.stringify(out[2]).length).toBeLessThan(400);
	});

	it("does not change the messages it was given", () => {
		const input = [toolResult("fetch_web", "正文\n已归档：x")];
		slimForSummary(input);
		expect(JSON.stringify(input)).toContain("正文");
	});
});

describe("writingState", () => {
	it("reads the topic from the disk", () => {
		mkdirSync(join(dir, "稿件"));
		writeFileSync(join(dir, "稿件", "初稿.md"), "正文内容");
		writeFileSync(join(dir, "稿件", "大纲.md"), "一、二、");
		writeFileSync(join(dir, "素材.md"), "# 素材\n\n- 甲\n- 乙\n");
		archiveSearch(dir, "甲", "结果", "时间", ["https://a.example/1"]);
		archivePage(
			dir,
			{ url: "https://a.example/1", title: "T", date: "", content: "正文" },
			"https://a.example/1",
			"sf",
			"时间",
		);
		const state = writingState([], dir);
		expect(state).toContain(`主题文件夹：${dir}`);
		expect(state.indexOf("大纲.md")).toBeLessThan(state.indexOf("初稿.md"));
		expect(state).toContain("素材 2 条，检索 1 次，页面 1 个");
		expect(state).toContain("先读大纲和当前稿件");
	});

	it("keeps the user's words in order, newest first when too long", () => {
		const entries = [
			entry({ role: "user", content: "最早的话".repeat(1200) }),
			entry({ role: "user", content: "要写三千字" }),
			entry({ role: "assistant", content: [{ type: "text", text: "好" }] }),
			entry({ role: "user", content: [{ type: "text", text: "再加一节" }] }),
		];
		const state = writingState(entries, undefined);
		expect(state).toContain("要写三千字");
		expect(state.indexOf("要写三千字")).toBeLessThan(state.indexOf("再加一节"));
		expect(state).not.toContain("最早的话");
	});

	it("names the skill read last", () => {
		const read = (path: string) =>
			entry({ role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path } }] });
		const state = writingState([read("/s/lieflat-gongwen/SKILL.md"), read("/s/report-analysis/SKILL.md")], undefined);
		expect(state).toContain("文体：report-analysis");
	});
});

describe("repeated compaction", () => {
	const preparation = (previousSummary?: string) =>
		({ messagesToSummarize: [], turnPrefixMessages: [], previousSummary }) as unknown as CompactionPreparation;

	it("hands the model only its own part of the last summary", () => {
		const out = prepareForSummary(preparation("## 写作状态\n旧状态\n\n## Decisions\n定了"));
		expect(out.previousSummary).toBe("## Decisions\n定了");
		expect(prepareForSummary(preparation("其他摘要")).previousSummary).toBe("其他摘要");
		expect(prepareForSummary(preparation()).previousSummary).toBeUndefined();
	});

	it("puts the state before the model's part, also on a local summary", () => {
		const result = { summary: "## Decisions\n定了" } as CompactionResult;
		expect(withWritingState(result, "## 写作状态\n新").summary).toBe("## 写作状态\n新\n\n## Decisions\n定了");
	});
});

describe("writerCompactionSettings, values the user chose", () => {
	it("leaves a configured value alone, and scales only the defaults", () => {
		const out = writerCompactionSettings({ enabled: true, reserveTokens: 5000, keepRecentTokens: 1 }, 1_000_000);
		expect(out).toMatchObject({ reserveTokens: 5000, keepRecentTokens: 1 });
	});
});
