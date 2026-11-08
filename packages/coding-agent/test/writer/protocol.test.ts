// The protocol of acting tools (src/writer/protocol.ts): the shape of a result and the limit on failures.
import { describe, expect, it } from "vitest";
import { createBreaker, outcome, outcomeText } from "../../src/writer/protocol.ts";

describe("outcome and outcomeText", () => {
	it("gives one JSON line, with long text after it", () => {
		const result = outcome("confirmed", "click", "model");
		expect(outcomeText(result)).toBe('{"effect":"confirmed","route":"click","next":"model","reason":""}');
		expect(outcomeText(result, "line")).toMatch(/\}\nline$/);
	});

	it("keeps data when there is some", () => {
		expect(outcome("failed", "x", "user", "why", { a: 1 }).data).toEqual({ a: 1 });
	});
});

describe("createBreaker", () => {
	it("stops a target after the second failure, and a success clears it", () => {
		const breaker = createBreaker();
		expect(breaker.allows("a")).toBe(true);
		expect(breaker.failed("a")).toBe(false);
		breaker.passed("a");
		expect(breaker.failed("a")).toBe(false);
		expect(breaker.failed("a")).toBe(true);
		expect(breaker.allows("a")).toBe(false);
		expect(breaker.allows("b")).toBe(true);
		breaker.reset();
		expect(breaker.allows("a")).toBe(true);
	});
});
