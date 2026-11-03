// Tests for src/writer/brand.ts: the product name in text a release package shows.
import { describe, expect, test } from "vitest";
import { brandText } from "../../src/writer/brand.ts";

describe("brandText", () => {
	test("leaves text alone in the source tree (name pi)", () => {
		// The upstream name stays so upstream tests see their own strings.
		expect(brandText("Pi can explain its own features.", "pi", "π")).toBe("Pi can explain its own features.");
	});

	test("replaces pi and Pi as words in a release package", () => {
		// Both spellings become the display name.
		expect(brandText("Use the terminal cursor instead of Pi's drawn cursor", "jiawriter", "JiaWriter")).toBe(
			"Use the terminal cursor instead of JiaWriter's drawn cursor",
		);
		expect(brandText("start pi and run /bug", "jiawriter", "JiaWriter")).toBe("start JiaWriter and run /bug");
	});

	test("keeps package names, paths, identifiers and words that contain pi", () => {
		// None of these is the product name on its own.
		const kept = "@earendil-works/pi-coding-agent ~/.pi/agent pi.registerTool api pipe PI_TELEMETRY spin";
		expect(brandText(kept, "jiawriter", "JiaWriter")).toBe(kept);
	});

	test("drops lines that point at pi.dev and the self-update alias", () => {
		// The share viewer line goes; the update usage loses "|pi".
		const help =
			"  update [source|self|pi]   Update pi\n  PI_SHARE_VIEWER_URL - default https://pi.dev/session/\nend";
		expect(brandText(help, "jiawriter", "JiaWriter")).toBe("  update [source|self]   Update JiaWriter\nend");
	});
});
