// The welcome box of a release package and the brand wordmark it opens with (2026-11-15).

// Test API.
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { WelcomeBox } from "../../src/modes/interactive/components/welcome-box.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { brandWordmarkLines, brandWordmarkText, WORDMARK_WIDTH } from "../../src/writer/logo.ts";

/** A box with the brand banner and two rows. */
function box() {
	return new WelcomeBox(() => ({
		banner: brandWordmarkLines(),
		bannerText: brandWordmarkText(),
		subtitle: "v1.4.0.13",
		rows: [
			{ label: "模型", value: "glm" },
			{ label: "文件夹", value: "~" },
		],
		hints: "/write 写文档",
	}));
}

describe("brand wordmark", () => {
	it("is four lines of half blocks, as wide as the letters, in one colour; the text form is bold", () => {
		initTheme("dark");
		const lines = brandWordmarkLines();
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(stripAnsi(line)).toHaveLength(WORDMARK_WIDTH);
		// Every letter leaves a mark on the top line, and the strokes are half blocks only.
		expect(stripAnsi(lines[0])).toMatch(/^[ ▀▄█]+$/);
		expect(stripAnsi(lines.join(""))).toMatch(/[▀▄█]/);
		expect(brandWordmarkText()).toContain("\x1b[1m");
		expect(stripAnsi(brandWordmarkText())).toBe("JiaWriter");
	});
});

describe("WelcomeBox", () => {
	it("frames the banner, the version, the rows and the hints, at most 72 columns wide", () => {
		initTheme("dark");
		const lines = box()
			.render(100)
			.map((l) => stripAnsi(l));
		expect(lines[0]).toMatch(/^ ╭─+╮$/);
		expect(lines.at(-1)).toMatch(/^ ╰─+╯$/);
		for (const line of lines) expect(visibleWidth(line)).toBe(73);
		// The banner lines, then the version, then the rows aligned on their labels.
		expect(lines.slice(1, 5).join("\n")).toMatch(/[▀▄█]/);
		expect(lines[5]).toContain("v1.4.0.13");
		expect(lines.some((l) => /模型\s+glm/.test(l))).toBe(true);
		expect(lines.some((l) => /文件夹\s+~/.test(l))).toBe(true);
		expect(lines.at(-2)).toContain("/write 写文档");
	});

	it("falls back to the text wordmark when the big one does not fit", () => {
		initTheme("dark");
		const lines = box()
			.render(50)
			.map((l) => stripAnsi(l));
		expect(lines[1]).toContain("JiaWriter");
		expect(lines.join("\n")).not.toMatch(/[▀▄█]/);
		for (const line of lines) expect(visibleWidth(line)).toBe(50);
	});
});
