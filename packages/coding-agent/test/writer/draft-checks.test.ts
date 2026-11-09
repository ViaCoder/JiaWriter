// The table of draft checks (src/writer/style/draft-checks.ts): which apply where, and failures before notes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_CHECKS, type DraftCheck, runDraftChecks } from "../../src/writer/style/draft-checks.ts";

beforeEach(() => vi.stubEnv("JW_LANG", "zh"));
afterEach(() => vi.unstubAllEnvs());

describe("runDraftChecks", () => {
	it("runs only the checks of the register, failures before notes", () => {
		const ran: string[] = [];
		const probe = (id: string, register: "report" | "general", fail: boolean): DraftCheck => ({
			id,
			when: (r) => r === register,
			run: () => {
				ran.push(id);
				return fail ? { fail: [id], note: [] } : { fail: [], note: [id] };
			},
		});
		const table = [probe("a", "report", false), probe("b", "general", true), probe("c", "report", true)];
		expect(runDraftChecks("正文", "report", table)).toEqual({ fail: ["c"], note: ["a"] });
		expect(ran).toEqual(["a", "c"]);
	});
	it("keeps the built-in checks in their order and applies documents' checks only to documents", () => {
		expect(DRAFT_CHECKS.map((c) => c.id)).toEqual([
			"citation",
			"headings",
			"list-markers",
			"placeholders",
			"ascii-quotes",
			"repeated",
			"evidence-first",
			"unsupported",
		]);
		const text = "## 1、问题\n\n一是人手不足。二是经费短缺。";
		expect(runDraftChecks(text, "general").fail).toEqual([]);
		expect(runDraftChecks(text, "report").fail.length).toBe(2);
	});
});
