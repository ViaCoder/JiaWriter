// Unit tests for src/writer/export/symbols.ts: LaTeX, HTML entities and escapes → Unicode symbols for Word.

// Test API.
import { describe, expect, it } from "vitest";
// Functions under test.
import { fixSymbols, latexToUnicode } from "../../src/writer/export/symbols.ts";

describe("latexToUnicode", () => {
	it("turns commands, scripts, fractions, roots, degrees and text into Unicode", () => {
		// Arrows, relations, operators and Greek.
		expect(latexToUnicode("A \\rightarrow B \\Rightarrow C")).toBe("A—B—C");
		expect(latexToUnicode("a \\leq b \\neq c \\times d \\pm e")).toBe("a≤b≠c×d±e");
		expect(latexToUnicode("\\alpha + \\Delta \\approx \\infty")).toBe("α+Δ≈∞");
		// Superscripts, subscripts, and the fallback when a character has no raised form.
		expect(latexToUnicode("x^2 + y^{10} + H_2O + a_{n+1}")).toBe("x²+y¹⁰+H₂O+aₙ₊₁");
		expect(latexToUnicode("e^{i\\pi} + x^b")).toBe("e^(iπ)+x^b");
		// Fractions, roots, degrees, text and escaped characters.
		expect(latexToUnicode("\\frac{1}{2} + \\frac{a+b}{c} + \\sqrt{2} + \\sqrt{x+1}")).toBe("1/2+(a+b)/c+√2+√(x+1)");
		expect(latexToUnicode("30^\\circ \\text{摄氏度}, 50\\%")).toBe("30°摄氏度,50%");
		// Spaces of math vanish (\\Delta T is ΔT); those in \\text{} and explicit ones stay.
		expect(latexToUnicode("\\Delta T \\quad \\text{in K}")).toBe("ΔT in K");
		expect(latexToUnicode("\\left( a \\right) \\{1, 2\\}")).toBe("(a){1,2}");
	});

	it("keeps an unknown command and reports it once", () => {
		// \foo has no Unicode form.
		const unknown: string[] = [];
		expect(latexToUnicode("\\foo + \\foo", unknown)).toBe("\\foo+\\foo");
		expect(unknown).toEqual(["\\foo"]);
	});
});

describe("fixSymbols", () => {
	it("converts math in $…$, $$…$$, \\(…\\) and \\[…\\], commands in the prose, entities and escapes", () => {
		// Every form once.
		const r = fixSymbols(
			"甲$\\rightarrow$乙，$$E=mc^2$$，\\(a \\leq b\\)，\\[x_1\\]，丙\\to丁，&rarr;&times;&#8594;&#x2192;，snake\\_case",
		);
		expect(r.text).toBe("甲—乙，E=mc²，a≤b，x₁，丙—丁，—×——，snake_case");
		expect([r.converted, r.unknown]).toEqual([10, []]);
	});

	it("leaves prices, citation brackets, code, URLs, paths and unknown entities alone", () => {
		// No command, ^, _ or brace, and a digit or words without an operator: no math.
		expect(fixSymbols("售价$100和$200").text).toBe("售价$100和$200");
		expect(fixSymbols("costs $x and $y").text).toBe("costs $x and $y");
		// Escaped brackets become plain brackets.
		expect(fixSymbols("见\\[1\\]").text).toBe("见[1]");
		// Code and URLs keep their characters; an unknown command in the prose and an unknown entity stay.
		const r = fixSymbols("`$\\alpha$` https://a.example/x_\\to C:\\Users\\data &foo;");
		expect(r.text).toBe("`$\\alpha$` https://a.example/x_\\to C:\\Users\\data &foo;");
		expect(r.converted).toBe(0);
	});

	it("reads a single variable or a short formula between $ as math", () => {
		// $A$, $x + y$ and $v=s/t$ are math.
		const r = fixSymbols("面积$A$与$x + y$成正比，$v=s/t$");
		expect([r.text, r.converted]).toEqual(["面积A与x+y成正比，v=s/t", 3]);
	});

	it("writes sideways arrows as a dash, however they were typed (the user, 2026-11-05)", () => {
		for (const text of ["甲$\\to$乙", "甲$/to$乙", "甲→乙", "甲 -> 乙", "甲=>乙", "甲⇒乙", "甲&rarr;乙"])
			expect(fixSymbols(text).text).toBe("甲—乙");
	});

	it("keeps what is not an arrow in prose", () => {
		expect(fixSymbols("`a -> b` 和 https://a.example/x->y").text).toBe("`a -> b` 和 https://a.example/x->y");
		expect(fixSymbols("x>=1，y<=2").text).toBe("x>=1，y<=2");
		expect(fixSymbols("销量$\\uparrow$").text).toBe("销量↑");
	});
});
