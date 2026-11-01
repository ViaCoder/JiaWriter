// Tests for scripts/writer-eval.mjs metrics (node:test).

// Assertions.
import assert from "node:assert/strict";
// Test runner.
import { test } from "node:test";
// Functions under test.
import { asciiPunctNearCjk, countMatches, metrics, TASKS } from "./writer-eval.mjs";

test("countMatches sums several patterns", () => {
	// Two different patterns.
	assert.equal(countMatches("甲乙甲丙", [/甲/g, /丙/g]), 3);
	// A single pattern.
	assert.equal(countMatches("aaa", /a/), 3);
});

test("asciiPunctNearCjk counts ASCII marks next to Chinese and skips decimals", () => {
	// Comma and full stop next to Chinese, a decimal, an English sentence.
	assert.equal(asciiPunctNearCjk("今天,天气好.增长3.5倍。Hello, world."), 2);
	// Full-width punctuation is fine.
	assert.equal(asciiPunctNearCjk("今天，天气好。"), 0);
});

test("metrics reports contrast frames, negations, cliches, markers and structure", () => {
	// A draft with every problem once.
	const m = metrics("这不是问题，而是机会。我们无法回避。综上所述，待核实。\n- 第一点");
	// Each counter sees its pattern.
	assert.deepEqual([m.contrast, m.cliches, m.markers, m.structuredLines], [1, 1, 1, 1]);
	// One negative assertion in four sentences: 2.5 per 10.
	assert.equal(m.negationPer10, 2.5);
	// Prohibitions are not counted as negative assertions.
	assert.equal(metrics("不得占用。严禁焚烧。").negationPer10, 0);
});

test("the task list has three Chinese prompts with unique ids", () => {
	// Three tasks.
	assert.equal(TASKS.length, 3);
	// Unique ids.
	assert.equal(new Set(TASKS.map((t) => t.id)).size, 3);
});
