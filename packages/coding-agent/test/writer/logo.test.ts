// Tests for src/writer/logo.ts: the "Jia" logo a release package shows in the startup header.
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { halfBlockLine, jiaHeader, jiaLogoLines, jiaWordmark, showsJiaLogo } from "../../src/writer/logo.ts";

/** Text without ANSI color codes. */
const plain = (s: string) => stripVTControlCharacters(s);

beforeAll(() => {
	// The logo reads the terminal's color mode from the theme.
	initTheme("dark");
});

describe("halfBlockLine", () => {
	test("turns two pixel rows into half blocks", () => {
		// Both, upper only, lower only, neither.
		expect(halfBlockLine("##..", "#.#.")).toBe("█▀▄ ");
	});
});

describe("jiaLogoLines", () => {
	test("draws J, i and a in four lines of equal width", () => {
		// The shapes without colors: capital J, thin dotted i, single-story a.
		const lines = jiaLogoLines();
		expect(lines.map(plain)).toEqual([" ▀▀█  ▄      ", "   █  ▄   ▄▄▄", "   █  █  █  █", "▀▄▄▀  █  ▀▄▄█"]);
		// Every line takes the same columns.
		for (const line of lines) expect(visibleWidth(line)).toBe(13);
	});

	test("colors each letter", () => {
		// Three letters, three colored runs per line.
		const [top] = jiaLogoLines();
		expect(top.split("\x1b[0m").filter((part) => part.includes("\x1b[")).length).toBe(3);
	});
});

describe("jiaHeader", () => {
	test("puts the version after the logo and the key hints below it", () => {
		// Four logo lines, the last with the version, then the hints.
		const lines = plain(jiaHeader("v1.4.0", "escape 中断\n/ 命令")).split("\n");
		expect(lines).toHaveLength(6);
		expect(lines[3]).toBe("▀▄▄▀  █  ▀▄▄█  v1.4.0");
		expect(lines.slice(4)).toEqual(["escape 中断", "/ 命令"]);
	});
});

describe("jiaWordmark", () => {
	test("reads Jia", () => {
		// The text fallback for terminals that cannot draw half blocks.
		expect(plain(jiaWordmark())).toBe("Jia");
	});
});

describe("showsJiaLogo", () => {
	test("only in a release package", () => {
		// The source tree keeps the pi logo; a package named jiawriter shows Jia.
		expect(showsJiaLogo("pi")).toBe(false);
		expect(showsJiaLogo("jiawriter")).toBe(true);
	});
});
