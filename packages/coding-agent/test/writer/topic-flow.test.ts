// Functional test: a whole writing topic through the real tools, with a fake AnySearch and a faux model:
// open the topic, search, fetch, record materials, write, edit, export automatically, resume.

// Temp files.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Faux provider helpers.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// Test API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Session store.
import { SessionManager } from "../../src/core/session-manager.ts";
// Extensions under test.
import writerDocsExtension from "../../src/extensions/writer-docs/index.ts";
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
import writerTopicExtension from "../../src/extensions/writer-topic/index.ts";
// The current topic.
import { currentTopic, setCurrentTopic } from "../../src/writer/topic/current.ts";
// Harness with the faux provider.
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";

const URL_A = "https://a.example/news";
const TOOLS = ["topic_open", "web_search", "web_fetch", "material_add", "write", "edit", "read", "import_document"];

describe("a writing topic", () => {
	let harness: Harness | undefined;
	let agentDir = "";
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "jw-flow-"));
		setCurrentTopic(undefined);
		vi.stubEnv("JW_SEARCH", "anysearch");
		vi.stubEnv("JW_DIR", agentDir);
		vi.stubEnv("JW_LANG", "zh");
		// Fake AnySearch.
		vi.stubGlobal("fetch", async (url: string) => {
			const data = String(url).endsWith("/v1/extract")
				? { url: URL_A, title: "巴黎新增绿地", content: "巴黎市政府新增绿地。".repeat(4000) }
				: { results: [{ title: "巴黎新增绿地", url: URL_A, snippet: "摘要" }] };
			return new Response(JSON.stringify({ code: 0, data }));
		});
	});
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setCurrentTopic(undefined);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A harness with the three extensions. */
	async function setup(sessionManager?: SessionManager): Promise<Harness> {
		return createHarness({
			extensionFactories: [writerTopicExtension, writerSearchExtension, writerDocsExtension],
			initialActiveToolNames: TOOLS,
			sessionManager,
		});
	}

	/** One tool call as a model reply. */
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

	it("keeps the research, materials and drafts in one folder", async () => {
		harness = await setup();
		const topic = join(harness.tempDir, "巴黎绿化");
		const draft = join("巴黎绿化", "稿件", "初稿.md");
		const material = {
			kind: "case",
			time: "2026年10月31日",
			reporter: "法新社",
			subject: "巴黎市政府",
			action: "新增绿地",
			url: URL_A,
		};
		harness.setResponses([
			call("topic_open", { name: "巴黎绿化" }),
			call("web_search", { query: "巴黎 绿地" }),
			// A page not opened yet is refused.
			call("material_add", { items: [material] }),
			call("web_fetch", { url: URL_A }),
			call("material_add", { items: [material] }),
			call("write", {
				path: draft,
				content: "# 巴黎绿化\n\n正文。\n\n## 参考文献\n\n1．[巴黎新增绿地，法新社](https://a.example/news)\n",
			}),
			call("edit", { path: draft, edits: [{ oldText: "正文。", newText: "修改后的正文。" }] }),
			fauxAssistantMessage("写好了"),
		]);
		await harness.session.prompt("写巴黎绿化");
		// The folder holds everything.
		expect(readdirSync(join(topic, "检索"))).toEqual(["001-巴黎 绿地.md"]);
		const pages = readdirSync(join(topic, "网页"));
		expect(pages).toEqual(["002-巴黎新增绿地.md"]);
		// The page is archived in full, beyond what the report gives the model.
		const page = readFileSync(join(topic, "网页", pages[0]), "utf-8");
		expect(page.length).toBeGreaterThan(40_000);
		expect(page).toContain(URL_A);
		expect(readFileSync(join(topic, "素材.md"), "utf-8")).toContain("巴黎市政府");
		// The refused call came first: only the second record is there.
		const results = harness.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "material_add");
		expect(results.map((r) => (r as { isError?: boolean }).isError)).toEqual([true, false]);
		// The draft was edited and exported beside itself; research stayed out of the export.
		expect(readFileSync(join(topic, "稿件", "初稿.md"), "utf-8")).toContain("修改后的正文");
		expect(existsSync(join(topic, "稿件", "初稿.docx"))).toBe(true);
		expect(readdirSync(join(topic, "网页")).some((f) => f.endsWith(".docx"))).toBe(false);
		expect(getToolResult(harness, "web_fetch").details).toMatchObject({ topicDir: topic });
	});

	it("archives into a dated folder when the model never opened a topic", async () => {
		harness = await setup();
		harness.setResponses([call("web_search", { query: "绿地" }), fauxAssistantMessage("好")]);
		await harness.session.prompt("查一下");
		const folder = readdirSync(harness.tempDir).find((f) => f.startsWith("未命名主题-"));
		expect(folder).toBeDefined();
		expect(readdirSync(join(harness.tempDir, folder as string, "检索"))).toHaveLength(1);
	});

	it("copies an imported file into the topic and finds the topic again in a resumed session", async () => {
		const sessions = SessionManager.inMemory();
		harness = await setup(sessions);
		const outside = join(agentDir, "资料.txt");
		writeFileSync(outside, "外部资料");
		harness.setResponses([
			call("topic_open", { name: "主题甲" }),
			call("import_document", { path: outside }),
			fauxAssistantMessage("好"),
		]);
		await harness.session.prompt("开始");
		const topic = currentTopic() as string;
		expect(readFileSync(join(topic, "参考资料", "资料.txt"), "utf-8")).toBe("外部资料");
		expect(existsSync(join(topic, "参考资料", ".parsed", "资料.txt.md"))).toBe(true);
		// A new start of the same session.
		setCurrentTopic(undefined);
		await harness.session.bindExtensions({});
		expect(currentTopic()).toBe(topic);
	});
});
