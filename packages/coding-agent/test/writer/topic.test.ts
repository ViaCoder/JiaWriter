// Unit tests for src/writer/topic: folder names, the research archive, materials and the current topic.

// Temp files.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { basename, join } from "node:path";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Functions under test.
import { currentTopic, ensureTopic, setCurrentTopic, topicFromEntries } from "../../src/writer/topic/current.ts";
import {
	addMaterials,
	archivedUrls,
	archiveFiltered,
	archivePage,
	archiveSearch,
	type Material,
	materialProblem,
	openTopic,
	readIndex,
	renderMaterial,
	safeName,
	topicPath,
	unnamedTopic,
} from "../../src/writer/topic/topic.ts";

// Working folder of each test.
let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "jw-topic-"));
	setCurrentTopic(undefined);
});
afterEach(() => {
	setCurrentTopic(undefined);
	rmSync(cwd, { recursive: true, force: true });
});

/** A complete case with a web source. */
const CASE: Material = {
	kind: "case",
	time: "2026年10月31日",
	reporter: "法新社",
	subject: "巴黎市政府",
	action: "新增绿地",
	url: "https://a.example/x",
};
/** A complete data point from a reference file. */
const DATA: Material = {
	kind: "data",
	time: "2025年",
	region: "苏州市",
	industry: "纺织业",
	indicator: "总产值",
	value: "1200亿元",
	file: "年鉴.pdf",
	page: "12",
};

describe("names and folders", () => {
	it("cleans a name for the file system", () => {
		expect(safeName(" 城市/绿化:调研? ")).toBe("城市 绿化 调研");
		expect(safeName("../..")).toBe("");
		expect(safeName("字".repeat(99))).toHaveLength(40);
	});

	it("uses the working folder itself when it carries the topic's name", () => {
		expect(topicPath("/w/绿化", "绿化")).toBe("/w/绿化");
		expect(topicPath("/w", "绿化")).toBe(join("/w", "绿化"));
	});

	it("creates the folders once and continues them after that", () => {
		const first = openTopic(cwd, "绿化调研");
		for (const sub of ["稿件", "参考资料", "检索", "网页"]) expect(existsSync(join(first.dir, sub))).toBe(true);
		expect(first.existed).toBe(false);
		expect(openTopic(cwd, "绿化调研").existed).toBe(true);
		expect(() => openTopic(cwd, "///")).toThrow();
	});

	it("names a topic by the local day when work starts without one", () => {
		expect(unnamedTopic(new Date(2026, 10, 5))).toBe("未命名主题-20261105");
	});
});

describe("archive", () => {
	it("numbers searches and pages across both kinds and keeps them readable", () => {
		const { dir } = openTopic(cwd, "t");
		const a = archiveSearch(dir, "城市 绿化", "结果列表", "2026-11-05 10:00");
		const b = archivePage(
			dir,
			{ url: "https://a.example/x", title: "标题/一", date: "2026-10-31", content: "全文" },
			"https://a.example/x",
			"browser",
			"时间",
		);
		expect(basename(a)).toBe("001-城市 绿化.md");
		expect(basename(b)).toBe("002-标题 一.md");
		expect(readFileSync(join(dir, a), "utf-8")).toContain("结果列表");
		const page = readFileSync(join(dir, b), "utf-8");
		for (const part of ["https://a.example/x", "2026-10-31", "browser", "全文"]) expect(page).toContain(part);
		expect(readIndex(dir).map((e) => e.kind)).toEqual(["search", "page"]);
	});

	it("keeps one file per page, and knows a page by the address asked for and the one it ended at", () => {
		const { dir } = openTopic(cwd, "t");
		const page = { url: "https://a.example/final", title: "T", date: "", content: "旧" };
		const first = archivePage(dir, page, "https://a.example/short", "browser", "时间");
		const again = archivePage(dir, { ...page, content: "新" }, "https://a.example/final", "browser", "时间");
		expect(again).toBe(first);
		expect(readFileSync(join(dir, first), "utf-8")).toContain("新");
		expect(archivedUrls(dir)).toEqual(expect.arrayContaining(["a.example/final", "a.example/short"]));
	});

	it("keeps text left out of a page beside its archive file", () => {
		const { dir } = openTopic(cwd, "t");
		const file = archivePage(
			dir,
			{ url: "https://a.example/x", title: "T", date: "", content: "x" },
			"https://a.example/x",
			"m",
			"时间",
		);
		const kept = archiveFiltered(dir, file, ["甲段", "乙段"]);
		expect(readFileSync(join(dir, kept), "utf-8")).toBe("甲段\n\n乙段\n");
		// Not one of the archive's own files.
		expect(readIndex(dir)).toHaveLength(1);
	});

	it("skips an index line that cannot be read", () => {
		const { dir } = openTopic(cwd, "t");
		expect(readIndex(dir)).toEqual([]);
		archiveSearch(dir, "甲", "结果", "时间");
		// A line cut off by a crash.
		appendFileSync(join(dir, ".index.jsonl"), '{"n":2,"ki\n');
		expect(readIndex(dir).map((e) => e.title)).toEqual(["甲"]);
		// The next file still gets a number of its own.
		expect(basename(archiveSearch(dir, "乙", "结果", "时间"))).toBe("002-乙.md");
	});
});

describe("materials", () => {
	it("names what is missing", () => {
		const opened = ["a.example/x"];
		expect(materialProblem(CASE, opened)).toBe("");
		expect(materialProblem(DATA, [])).toBe("");
		expect(materialProblem({ ...CASE, reporter: " " }, opened)).toContain("reporter");
		expect(materialProblem({ ...DATA, value: "" }, [])).toContain("value");
		expect(materialProblem({ ...DATA, page: "" }, [])).toContain("年鉴.pdf");
		expect(materialProblem({ ...CASE, url: "" }, opened)).not.toBe("");
		// A page never opened in the topic is refused.
		expect(materialProblem(CASE, [])).toContain("https://a.example/x");
	});

	it("renders one line with every field and the source", () => {
		const line = renderMaterial({ ...CASE, section: "二、问题" });
		for (const part of ["【二、问题】", "2026年10月31日", "法新社", "巴黎市政府", "新增绿地", "https://a.example/x"])
			expect(line).toContain(part);
		expect(renderMaterial(DATA)).toContain("《年鉴.pdf》第12页");
	});

	it("writes all items or none, and counts what the file holds", () => {
		const { dir } = openTopic(cwd, "t");
		archivePage(
			dir,
			{ url: "https://a.example/x", title: "T", date: "", content: "x" },
			"https://a.example/x",
			"m",
			"时间",
		);
		expect(() => addMaterials(dir, [DATA, { ...CASE, url: "https://b.example/" }])).toThrow("第2条");
		expect(existsSync(join(dir, "素材.md"))).toBe(false);
		expect(addMaterials(dir, [CASE])).toBe(1);
		expect(addMaterials(dir, [DATA])).toBe(2);
		expect(readFileSync(join(dir, "素材.md"), "utf-8")).toContain("总产值");
	});
});

describe("current topic", () => {
	it("opens a dated topic when none is set, and keeps a set one", () => {
		expect(currentTopic()).toBeUndefined();
		const dir = ensureTopic(cwd, new Date(2026, 10, 5));
		expect(basename(dir)).toBe("未命名主题-20261105");
		expect(existsSync(join(dir, "网页"))).toBe(true);
		setCurrentTopic("/x");
		expect(ensureTopic(cwd)).toBe("/x");
	});

	it("reads the latest topic of a session branch", () => {
		const entry = (topicDir?: string, role = "toolResult") => ({ message: { role, details: { topicDir } } });
		expect(topicFromEntries([entry("/a"), entry(), entry("/b"), entry("/c", "user")])).toBe("/b");
		expect(topicFromEntries([{ type: "label" }])).toBeUndefined();
	});
});
