// Sites held for the user's verification (src/writer/held-sites.ts, writer-guard): 2026-11-09, after a slider wall a
// run tried to drag it, then probed the site with curl for a way around it.
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerGuardExtension from "../../src/extensions/writer-guard/index.ts";
import { pageVerdict } from "../../src/writer/browser/fetch.ts";
import { heldIn, holdSite, releaseSite, resetHeldSites } from "../../src/writer/held-sites.ts";
import { setUiLang } from "../../src/writer/i18n/index.ts";

afterEach(() => resetHeldSites());

describe("held sites", () => {
	it("holdSite / heldIn / releaseSite / resetHeldSites", () => {
		holdSite("127.0.0.1");
		holdSite("Gov.Example.cn");
		expect(heldIn("curl -s http://127.0.0.1:37713/wall")).toBe("127.0.0.1");
		expect(heldIn('{"url":"https://gov.example.cn/a"}')).toBe("gov.example.cn");
		expect(heldIn("ls -la")).toBe("");
		releaseSite("127.0.0.1");
		expect(heldIn("curl http://127.0.0.1/")).toBe("");
		resetHeldSites();
		expect(heldIn("https://gov.example.cn/")).toBe("");
	});

	it("pageVerdict: a short slider page is a wall", () => {
		const probe = {
			title: "安全验证",
			excerpt: "请完成安全验证 拖动滑块完成拼图后继续访问。 ▶",
			cfCleared: false,
			cfChallenge: false,
			challengeIframe: false,
		};
		expect(pageVerdict(probe as never)).toBe("challenge");
	});

	it("writer-guard refuses every tool but the browser on a held site, until the user's next message", () => {
		setUiLang("zh");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		writerGuardExtension({
			on: (name: string, fn: (event: unknown) => unknown) => {
				handlers[name] = fn;
			},
		} as unknown as ExtensionAPI);
		handlers.input({});
		holdSite("127.0.0.1");
		const bash = handlers.tool_call({
			toolName: "bash",
			input: { command: "curl -s http://127.0.0.1:37713/wall" },
		}) as { block: boolean; reason: string };
		expect(bash.block).toBe(true);
		expect(bash.reason).toContain("只能由用户本人完成");
		expect(
			(
				handlers.tool_call({ toolName: "fetch_web", input: { url: "http://127.0.0.1:37713/wall" } }) as {
					block: boolean;
				}
			).block,
		).toBe(true);
		expect(handlers.tool_call({ toolName: "browser", input: { action: "read" } })).toBeUndefined();
		// The user's next message: they may have passed it.
		handlers.input({});
		expect(
			handlers.tool_call({ toolName: "bash", input: { command: "curl -s http://127.0.0.1:37713/wall" } }),
		).toBeUndefined();
	});
});
