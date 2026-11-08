// The question tool: the choices shown, the answer passed back, and the answer when nobody can give one.
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerAskExtension, { choiceLines, MAX_CHOICES } from "../../src/extensions/writer-ask/index.ts";

describe("choiceLines", () => {
	it("trims, drops repeats, keeps at most MAX_CHOICES and ends with the line for one's own answer", () => {
		expect(choiceLines([" 通知 ", "通知", "意见", ""], "其他")).toEqual(["通知", "意见", "其他"]);
		expect(choiceLines(["a", "b", "c", "d", "e"], "其他").length).toBe(MAX_CHOICES + 1);
	});
});

describe("ask_user", () => {
	/** The tool's execute with a scripted interface. */
	function load(picks: (string | undefined)[], typed?: string, hasUI = true) {
		let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
		writerAskExtension({
			registerTool: (def: never) => {
				tool = def;
			},
		} as unknown as ExtensionAPI);
		const ctx = { hasUI, ui: { select: async () => picks.shift(), input: async () => typed } };
		return (params: unknown) => tool?.execute("1", params, undefined, undefined, ctx).then((r) => r.content[0].text);
	}
	const params = { question: "文种？", choices: ["通知", "意见"] };

	it("passes back the picked choice or the typed answer", async () => {
		expect(await load(["意见"])(params)).toContain("意见");
		expect(await load(["其他（自己输入）"], "函")(params)).toContain("函");
	});

	it("says to go on with the usual choice when nobody answers, or with fewer than two choices", async () => {
		expect(await load([undefined])(params)).toContain("通常");
		expect(await load([], undefined, false)(params)).toContain("通常");
		expect(await load([])({ question: "?", choices: ["只有一个"] })).toContain("两个");
	});
});
