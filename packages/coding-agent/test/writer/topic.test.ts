// Unit tests for src/writer/topic: folder names, the research archive, materials and the current topic.

// Temp files.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	adoptUnnamedTopic,
	archivedUrls,
	archiveFiltered,
	archivePage,
	archiveSearch,
	asFileSource,
	excerptOf,
	fileSourceText,
	isUnnamedTopic,
	longAnchors,
	MAX_ANCHOR,
	MAX_QUOTE,
	type Material,
	materialCount,
	materialExcerpt,
	materialProblem,
	materialUrls,
	openAutoTopic,
	openTopic,
	pageReporter,
	readIndex,
	renderMaterial,
	safeName,
	siteName,
	topicPath,
	topicWords,
	webSourceTexts,
	withPageReporters,
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
	start: "巴黎市政府新增绿地",
	quote: "巴黎市政府新增绿地 12 公顷。",
	url: "https://a.example/x",
};
/** A complete data point from a reference file. */
const DATA: Material = {
	kind: "data",
	time: "2025年",
	start: "苏州市纺织业总产值",
	quote: "苏州市纺织业总产值1200亿元。",
	file: "年鉴.pdf",
	page: "12",
};

describe("names and folders", () => {
	it("cleans a name for the file system", () => {
		expect(safeName(" 城市/绿化:调研? ")).toBe("城市 绿化 调研");
		expect(safeName("../..")).toBe("");
		expect(safeName("字".repeat(99))).toHaveLength(40);
	});

	it("dates a new topic and keeps its first three words", () => {
		const day = new Date(2026, 10, 6);
		expect(topicPath("/w", "绿化", day)).toBe(join("/w", "20261106-绿化"));
		expect(topicPath("/w", "城市 绿化 政策 调研", day)).toBe(join("/w", "20261106-城市-绿化-政策"));
		expect(topicPath("/w", "20261105-绿化", day)).toBe(join("/w", "20261105-绿化"));
	});

	it("uses the working folder itself when it carries the topic's name", () => {
		expect(topicPath("/w/绿化", "绿化")).toBe("/w/绿化");
		expect(topicPath("/w/20261105-绿化", "绿化")).toBe("/w/20261105-绿化");
		expect(topicPath("/w/20261105-绿化", "20261105-绿化")).toBe("/w/20261105-绿化");
	});

	it("continues a topic with the same words on a later day, in its latest folder", () => {
		const first = openTopic(cwd, "绿化", new Date(2026, 10, 5)).dir;
		expect(basename(first)).toBe("20261105-绿化");
		expect(openTopic(cwd, "绿化", new Date(2026, 10, 7))).toEqual({ dir: first, existed: true });
		mkdirSync(join(cwd, "20261106-绿化"));
		expect(basename(openTopic(cwd, "绿化").dir)).toBe("20261106-绿化");
	});

	it("continues a folder from before dates", () => {
		mkdirSync(join(cwd, "旧主题"));
		expect(openTopic(cwd, "旧主题").dir).toBe(join(cwd, "旧主题"));
	});

	it("creates the folders once and continues them after that", () => {
		const first = openTopic(cwd, "绿化调研");
		for (const sub of ["稿件", "参考资料", "检索", "网页"]) expect(existsSync(join(first.dir, sub))).toBe(true);
		expect(first.existed).toBe(false);
		expect(openTopic(cwd, "绿化调研").existed).toBe(true);
		expect(() => openTopic(cwd, "///")).toThrow();
	});
});

describe("topicWords", () => {
	it.each([
		["FCC October 29 2026 new rules regulation October 29 FCC 新规", "FCC-new-rules"],
		["FCC 10月29日 新规 中国 2025 2026", "FCC-新规-中国"],
		['site:fcc.gov "26-73" "2026"', "26-73"],
		["FCC testing laboratories October 29 November 2026", "FCC-testing-laboratories"],
		["城市绿化", "城市绿化"],
		["2026", ""],
		["", ""],
	])("takes the words of %s", (text, words) => {
		expect(topicWords(text)).toBe(words);
	});
});

describe("adoptUnnamedTopic", () => {
	const day = new Date(2026, 10, 6);

	it("names a topic after the search at hand, and marks only a folder it made", () => {
		const dir = openAutoTopic(cwd, "FCC 新规", day);
		expect(basename(dir)).toBe("20261106-FCC-新规");
		expect(isUnnamedTopic(dir)).toBe(true);
		expect(basename(openAutoTopic(cwd, "2026", day))).toBe("20261106-资料");
		const named = openTopic(cwd, "已有", day).dir;
		expect(openAutoTopic(cwd, "已有", day)).toBe(named);
		expect(isUnnamedTopic(named)).toBe(false);
	});

	it("gives research done first the topic's name, with its archive", () => {
		const dir = openAutoTopic(cwd, "甲", day);
		archiveSearch(dir, "甲", "结果", "时间", ["https://a.example/x"]);
		expect(adoptUnnamedTopic(dir, cwd, "城市绿化", day)).toBe(true);
		const named = join(cwd, "20261106-城市绿化");
		expect(existsSync(dir)).toBe(false);
		expect(materialUrls(named)).toEqual(["a.example/x"]);
		expect(isUnnamedTopic(named)).toBe(false);
	});

	it("stops counting a folder as unnamed when the model gives it the same words", () => {
		const dir = openAutoTopic(cwd, "绿化", day);
		expect(adoptUnnamedTopic(dir, cwd, "绿化", day)).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(isUnnamedTopic(dir)).toBe(false);
	});

	it("leaves everything alone when the name is taken, the folder is named, or the name is empty", () => {
		const unnamed = openAutoTopic(cwd, "甲", day);
		openTopic(cwd, "已有", day);
		expect(adoptUnnamedTopic(unnamed, cwd, "已有", day)).toBe(false);
		expect(adoptUnnamedTopic(unnamed, cwd, "///", day)).toBe(false);
		expect(existsSync(unnamed)).toBe(true);
		expect(adoptUnnamedTopic(openTopic(cwd, "别的").dir, cwd, "新名")).toBe(false);
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

	it("names a file from words, never from an address", () => {
		const { dir } = openTopic(cwd, "t");
		const page = { url: "https://news.example.com/a?b=1", title: "", date: "", content: "# 第一行正文\n\n第二行" };
		const named = archivePage(dir, page, page.url, "codex", "时间");
		expect(basename(named)).toBe("001-第一行正文 第二行.md");
		// The address stays inside the file.
		expect(readFileSync(join(dir, named), "utf-8")).toContain(page.url);
		const bare = { ...page, url: "https://news.example.com/b", content: "https://news.example.com/b" };
		expect(basename(archivePage(dir, bare, bare.url, "codex", "时间"))).toBe("002-page.md");
		const titled = { ...page, url: "https://news.example.com/c", title: "https://news.example.com/c" };
		expect(basename(archivePage(dir, titled, titled.url, "codex", "时间"))).toBe("003-page.md");
		expect(basename(archiveSearch(dir, "绿化 site:fcc.gov www.example.com/a", "结果", "时间"))).toBe("004-绿化.md");
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
			{ url: "https://a.example/x", title: "T", date: "2026-10-31", content: "2025年数据" },
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
		// A case from the user's own file needs no outlet, and the message says what each field means (2026-11-09).
		const fromFile: Material = {
			kind: "case",
			time: "2025年7月",
			subject: "城西物流园冷库",
			start: "城西物流园冷库发生氨泄漏",
			file: "材料.md",
		};
		expect(materialProblem(fromFile, [])).toBe("");
		expect(materialProblem({ ...CASE, reporter: undefined }, opened)).toMatch(/reporter.*subject/);
		expect(renderMaterial(fromFile)).not.toContain("报道方");
		expect(renderMaterial(fromFile)).toContain("主体：城西物流园冷库");
		expect(materialProblem({ ...DATA, start: "" }, [])).toContain("start");
		expect(materialProblem({ ...DATA, page: "" }, [])).toContain("年鉴.pdf");
		expect(materialProblem({ ...CASE, url: "" }, opened)).not.toBe("");
		// A case with no source is asked for its source, not for the reporter only web cases need (2026-11-10: the
		// same call was retried until the loop guard ended the turn).
		const noSource = materialProblem({ ...fromFile, file: undefined }, []);
		expect(noSource).toContain("缺少来源");
		expect(noSource).not.toContain("reporter");
		// A page never opened in the topic is refused.
		expect(materialProblem(CASE, [])).toContain("https://a.example/x");
	});

	it("takes any address from search results as a source, and keeps it apart from opened pages", () => {
		const { dir } = openTopic(cwd, "t");
		archiveSearch(dir, "甲", "结果", "时间", ["https://www.a.example/x/", "ftp://b.example/file", "不是网址"]);
		expect(materialUrls(dir)).toEqual(["a.example/x", "ftp://b.example/file", "不是网址"]);
		expect(archivedUrls(dir)).toEqual([]);
		// Compared in normalized form, and the same way for what is not a web address.
		expect(materialProblem({ ...CASE, url: "https://a.example/x" }, materialUrls(dir))).toBe("");
		expect(materialProblem({ ...CASE, url: "不是网址" }, materialUrls(dir))).toBe("");
		expect(materialProblem({ ...CASE, url: "ftp://other.example/" }, materialUrls(dir))).not.toBe("");
	});

	it("renders one line with every field and the source", () => {
		const line = renderMaterial({ ...CASE, section: "二、问题" });
		for (const part of ["【二、问题】", "2026年10月31日", "法新社", "巴黎市政府", "新增绿地", "https://a.example/x"])
			expect(line).toContain(part);
		expect(renderMaterial(DATA)).toContain("《年鉴.pdf》第12页");
		// A file without pages is cited by its name alone.
		expect(renderMaterial({ ...DATA, file: "报告.txt", page: "" }).endsWith("来源：《报告.txt》")).toBe(true);
		// A place that is not a page number is written as given (2026-11-09: 第第1条页).
		expect(renderMaterial({ ...DATA, page: "第1条" }).endsWith("《年鉴.pdf》第1条")).toBe(true);
		expect(renderMaterial({ ...DATA, page: "3-4" }).endsWith("《年鉴.pdf》第3-4页")).toBe(true);
	});

	it("takes a local path given as url for the file, and asks no page of a file that has none", () => {
		const local = { ...DATA, file: undefined, page: undefined, url: "参考资料/报告.txt" };
		expect(asFileSource(local)).toMatchObject({ file: "参考资料/报告.txt", url: undefined });
		expect(asFileSource(CASE)).toBe(CASE);
		expect(materialProblem(asFileSource(local), [])).toBe("");
		expect(materialProblem({ ...DATA, file: "参考资料/.parsed/报告.txt.md", page: "" }, [])).toBe("");
		expect(materialProblem({ ...DATA, file: "年鉴.pdf", page: "" }, [])).toContain("页码");
	});

	it("writes the complete items, sends the others back, and counts what the file holds", () => {
		const { dir } = openTopic(cwd, "t");
		archivePage(
			dir,
			{
				url: "https://a.example/x",
				title: "T",
				date: "2026-10-31",
				content: "2025年数据。巴黎市政府新增绿地12公顷。",
			},
			"https://a.example/x",
			"m",
			"时间",
		);
		// The yearbook as imported.
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "年鉴.pdf.md"), "苏州市纺织业总产值1200亿元。");
		// The yearbook item goes in; the case with an unknown address comes back (2026-11-11: all-or-none made a model
		// resend 18 items for 2 wrong ones).
		const first = addMaterials(dir, [DATA, { ...CASE, url: "https://b.example/" }]);
		expect(first).toMatchObject({ total: 1, written: [1] });
		expect(first.problems).toHaveLength(1);
		expect(first.problems[0]).toContain("第2条");
		expect(addMaterials(dir, [CASE])).toMatchObject({ total: 2, written: [1], problems: [] });
		expect(materialCount(dir)).toBe(2);
		// The passages as the program took them.
		const written = readFileSync(join(dir, "素材.md"), "utf-8");
		expect(written).toContain("原文：“巴黎市政府新增绿地12公顷。”");
		expect(written).toContain("原文：“苏州市纺织业总产值1200亿元。”");
	});
});

// Materials are passages the program takes out of their sources: the model names them by their first and last words
// (the user, 2026-11-11: "Not a verbatim transcription, but rather an extraction and output generated by an AI-powered
// program").
describe("excerpts", () => {
	const TEXT =
		"据统计，**2025年**全市新增绿地 12 公顷。\n市长说：“明年再增 20 公顷。” 详见[公告](https://a.example/g)。";

	it("excerptOf: the passage from start through end as the source writes it, despite spaces, width and marks", () => {
		expect(excerptOf(TEXT, "2025年全市", "12公顷")).toBe("2025年全市新增绿地 12 公顷");
		// Without end, through the end of start's sentence; a start that is a whole sentence stops there.
		expect(excerptOf(TEXT, "全市新增绿地")).toBe("全市新增绿地 12 公顷。");
		expect(excerptOf(TEXT, "据统计，2025年全市新增绿地12公顷。")).toBe("据统计，2025年全市新增绿地 12 公顷。");
		// Across lines, onto one line, the link kept as its text.
		expect(excerptOf(TEXT, "全市新增", "详见公告")).toBe(
			"全市新增绿地 12 公顷。 市长说：“明年再增 20 公顷。” 详见公告",
		);
		expect(excerptOf(TEXT, '市长说:"明年')).toBe("市长说：“明年再增 20 公顷。");
		// An end inside start's own words is not taken for one before it.
		expect(excerptOf(TEXT, "全市新增绿地", "绿地")).toBe("全市新增绿地");
		// Words the source does not have, and an end before start, give nothing.
		expect(excerptOf(TEXT, "全市绿化面积大幅增加")).toBe("");
		expect(excerptOf(TEXT, "明年再增", "全市新增")).toBe("");
		expect(excerptOf(TEXT, "  ")).toBe("");
		// English: a sentence ends at a full stop before a space.
		const en = "In 2025 Paris added 12 hectares of green space. The city plans more.";
		expect(excerptOf(en, "Paris added")).toBe("Paris added 12 hectares of green space.");
		expect(excerptOf(en, "paris ADDED 12", "plans more")).toBe(
			"Paris added 12 hectares of green space. The city plans more",
		);
	});

	it("longAnchors: whole sentences as start or end, which a few words would do", () => {
		expect(longAnchors([CASE, DATA])).toBe(false);
		expect(longAnchors([CASE, { ...DATA, start: "字".repeat(MAX_ANCHOR + 1) }])).toBe(true);
		expect(longAnchors([{ ...CASE, end: "字".repeat(MAX_ANCHOR + 1) }])).toBe(true);
		// Items sent back say so too, so that the next call is short.
		const { dir } = openTopic(cwd, "t");
		archivePage(
			dir,
			{ url: "https://a.example/x", title: "T", date: "2026-10-31", content: "巴黎市政府新增绿地 12 公顷。" },
			"https://a.example/x",
			"m",
			"时间",
		);
		// Only when something is sent back; a call that went in whole is told by the extension instead.
		expect(addMaterials(dir, [{ ...CASE, start: "字".repeat(MAX_ANCHOR + 1), url: "" }]).problems.join()).toContain(
			"不用整句照抄",
		);
		expect(addMaterials(dir, [CASE]).problems).toEqual([]);
	});

	it("addMaterials: items with no source and no start are told in one line that their content was lost", () => {
		const { dir } = openTopic(cwd, "t");
		archivePage(
			dir,
			{ url: "https://a.example/x", title: "T", date: "2026-10-31", content: "巴黎市政府新增绿地 12 公顷。" },
			"https://a.example/x",
			"m",
			"时间",
		);
		const bare = { kind: "case", reporter: "中工网", section: "问题" } as Material;
		expect(addMaterials(dir, [bare, bare]).problems).toEqual([expect.stringContaining("这 2 条只有类别")]);
		// One complete item among them: each is checked as usual, and the complete one goes in.
		expect(addMaterials(dir, [bare, CASE])).toMatchObject({
			written: [2],
			problems: [expect.stringContaining("第1条")],
		});
	});

	it("webSourceTexts: the fetched page and only its own entry of a search report", () => {
		const { dir } = openTopic(cwd, "t");
		const report = [
			"1. 甲",
			"   https://a.example/x（2026-10-31）",
			"   甲市新增绿地。",
			"2. 乙",
			"   https://b.example/y",
			"   乙市拆除绿地。",
		].join("\n");
		archiveSearch(dir, "绿地", report, "时间", ["https://a.example/x", "https://b.example/y?from="]);
		const [entry] = webSourceTexts(dir, "https://a.example/x");
		expect(entry).toContain("甲市新增绿地");
		expect(entry).not.toContain("乙市");
		// Its title is the source's words too.
		expect(entry.startsWith("1. 甲")).toBe(true);
		// An address listed with an empty parameter is the same source.
		expect(webSourceTexts(dir, "https://b.example/y").join("")).toContain("乙市拆除绿地");
		archivePage(
			dir,
			{ url: "https://a.example/x", title: "甲", date: "", content: "正文全文。" },
			"https://a.example/x",
			"m",
			"时间",
		);
		expect(webSourceTexts(dir, "https://a.example/x").join("\n")).toContain("正文全文");
		expect(webSourceTexts(dir, "https://never.example/")).toEqual([]);
	});

	it("fileSourceText: the parsed copy of an imported file, a text file as it stands, else nothing", () => {
		const { dir } = openTopic(cwd, "t");
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "年鉴.pdf.md"), "苏州市纺织业总产值1200亿元。");
		expect(fileSourceText(dir, "年鉴.pdf")).toContain("1200亿元");
		expect(fileSourceText(dir, "参考资料/年鉴.pdf")).toContain("1200亿元");
		writeFileSync(join(cwd, "笔记.txt"), "冷库发生氨泄漏。");
		expect(fileSourceText(dir, "笔记.txt")).toContain("氨泄漏");
		expect(fileSourceText(dir, "没有.pdf")).toBeUndefined();
	});

	it("materialExcerpt: takes the passage from the page, the search entry or the file, or says why it cannot", () => {
		const { dir } = openTopic(cwd, "t");
		archiveSearch(dir, "绿地", "1. 巴黎\n   https://a.example/x\n   摘要：巴黎扩绿。", "时间", [
			"https://a.example/x",
		]);
		// From the search entry before the page is opened.
		expect(materialExcerpt(dir, { ...CASE, start: "巴黎扩绿" })).toEqual({ quote: "巴黎扩绿。", problem: "" });
		archivePage(
			dir,
			{ url: "https://a.example/x", title: "T", date: "", content: "巴黎市政府新增绿地 12 公顷。" },
			"https://a.example/x",
			"m",
			"时间",
		);
		expect(materialExcerpt(dir, CASE).quote).toBe("巴黎市政府新增绿地 12 公顷。");
		expect(materialExcerpt(dir, { ...CASE, start: "巴黎绿化成效显著" }).problem).toContain("巴黎绿化成效显著");
		expect(materialExcerpt(dir, { ...CASE, end: "没有的话" }).problem).toContain("巴黎市政府新增绿地……没有的话");
		archivePage(
			dir,
			{ url: "https://b.example/", title: "T", date: "", content: `${"绿".repeat(MAX_QUOTE)}。` },
			"https://b.example/",
			"m",
			"时间",
		);
		expect(materialExcerpt(dir, { ...CASE, url: "https://b.example/", start: "绿绿" }).problem).toContain(
			`${MAX_QUOTE}`,
		);
		// A file that was never imported cannot be read, and the model is told to import it.
		expect(materialExcerpt(dir, DATA).problem).toContain("import_document");
		mkdirSync(join(cwd, "参考资料", ".parsed"), { recursive: true });
		writeFileSync(join(cwd, "参考资料", ".parsed", "年鉴.pdf.md"), "2025年，苏州市纺织业总产值1200亿元。");
		expect(materialExcerpt(dir, DATA)).toEqual({ quote: "苏州市纺织业总产值1200亿元。", problem: "" });
	});
});

describe("current topic", () => {
	it("opens a topic named after the work when none is set, and keeps a set one", () => {
		expect(currentTopic()).toBeUndefined();
		const dir = ensureTopic(cwd, "城市 绿化", new Date(2026, 10, 5));
		expect(basename(dir)).toBe("20261105-城市-绿化");
		expect(existsSync(join(dir, "网页"))).toBe(true);
		setCurrentTopic("/x");
		expect(ensureTopic(cwd, "别的")).toBe("/x");
	});

	it("reads the latest topic of a session branch", () => {
		const entry = (topicDir?: string, role = "toolResult") => ({ message: { role, details: { topicDir } } });
		expect(topicFromEntries([entry("/a"), entry(), entry("/b"), entry("/c", "user")])).toBe("/b");
		expect(topicFromEntries([{ type: "label" }])).toBeUndefined();
	});
});

// The outlet of a web case from the page it was fetched from (2026-11-09: a research run gave a fetched 新华网 page
// nine times without reporter and ended with no draft).
describe("pageReporter / withPageReporters", () => {
	/** A page as the run on 2026-11-09 fetched it. */
	const XINHUA = {
		url: "https://www.news.cn/20251222/15fef6ce60024e5aac0226a0d88924a1/c.html",
		title: "市场最前沿｜逐空而上！低空经济加速启航万亿新赛道 - 新华网 > 新闻 > 正文",
		date: "2025-12-22",
		content:
			"新华网 > 新闻 > 正文\n\n2025 12/22 20:19:04\n\n来源：新华网\n\n# 市场最前沿\n\n国产首款800公斤级重载eVTOL首飞成功。",
	};
	const CASE_NO_REPORTER: Material = {
		kind: "case",
		time: "2025年12月22日",
		subject: "国产AR-E800飞行器",
		start: "国产首款800公斤级",
		url: XINHUA.url,
	};

	it("pageReporter: the page's 来源 line, else the site at the end of its title, else nothing", () => {
		const dir = openTopic(cwd, "低空经济").dir;
		archivePage(dir, XINHUA, XINHUA.url, "deepseek", "时间");
		expect(pageReporter(dir, XINHUA.url)).toBe("新华网");
		archivePage(
			dir,
			{ url: "https://b.example/1", title: "低空经济观察 - 人民日报", date: "", content: "正文" },
			"https://b.example/1",
			"x",
			"t",
		);
		expect(pageReporter(dir, "https://b.example/1")).toBe("人民日报");
		archivePage(
			dir,
			{ url: "https://c.example/1", title: "低空经济观察", date: "", content: "正文" },
			"https://c.example/1",
			"x",
			"t",
		);
		expect(pageReporter(dir, "https://c.example/1")).toBe("");
		expect(pageReporter(dir, "https://never.example/")).toBe("");
		// 来源：C114 2026-04-20, the line a research run stopped at.
		archivePage(
			dir,
			{
				url: "https://www.c114.net.cn/industry/77324.html",
				title: "民航局：全年无人机累计飞行小时",
				date: "",
				content: "民航局：全年无人机累计飞行小时  来源：C114 2026-04-20  C114讯 4月20日消息",
			},
			"https://www.c114.net.cn/industry/77324.html",
			"x",
			"t",
		);
		expect(pageReporter(dir, "https://www.c114.net.cn/industry/77324.html")).toBe("C114");
	});

	it("siteName: the site of an address", () => {
		expect(siteName("https://www.c114.net.cn/industry/77324.html")).toBe("c114.net.cn");
		expect(siteName("not an address")).toBe("");
	});

	it("withPageReporters: fills only web cases without an outlet", () => {
		const dir = openTopic(cwd, "低空经济").dir;
		archivePage(dir, XINHUA, XINHUA.url, "deepseek", "时间");
		const [filled, kept, data] = withPageReporters(dir, [
			CASE_NO_REPORTER,
			{ ...CASE_NO_REPORTER, reporter: "央视新闻" },
			DATA,
		]);
		expect(filled.reporter).toBe("新华网");
		expect(kept.reporter).toBe("央视新闻");
		expect(data).toBe(DATA);
	});

	it("addMaterials: a case from a fetched page is recorded with the page's outlet", () => {
		const dir = openTopic(cwd, "低空经济").dir;
		archivePage(dir, XINHUA, XINHUA.url, "deepseek", "时间");
		addMaterials(dir, [CASE_NO_REPORTER]);
		expect(readFileSync(join(dir, "素材.md"), "utf-8")).toContain("报道方：新华网");
		// A page that names no outlet still asks for one.
		archivePage(
			dir,
			{
				url: "https://c.example/1",
				title: "观察",
				date: "2025-12-22",
				content: "国产首款800公斤级重载eVTOL首飞成功。",
			},
			"https://c.example/1",
			"x",
			"t",
		);
		// A page that names no outlet: the site it is on (a run never stops for want of one).
		addMaterials(dir, [{ ...CASE_NO_REPORTER, url: "https://c.example/1" }]);
		expect(readFileSync(join(dir, "素材.md"), "utf-8")).toContain("报道方：c.example");
	});
});
