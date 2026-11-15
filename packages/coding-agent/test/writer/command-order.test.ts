// The order of the / menu: the writer's commands lead, the rest keep their order.
import { describe, expect, it } from "vitest";
import { LEADING_COMMANDS, orderCommands } from "../../src/writer/command-order.ts";

describe("orderCommands", () => {
	it("puts the leading commands first in their fixed order and keeps the others' order", () => {
		const given = ["settings", "model", "tree", "mcp", "write", "jw", "research", "llama", "memory"].map((name) => ({
			name,
		}));
		expect(orderCommands(given).map((c) => c.name)).toEqual([
			"write",
			"research",
			"memory",
			"jw",
			"model",
			"settings",
			"tree",
			"mcp",
			"llama",
		]);
	});
	it("leads with the document and research commands, and names no command twice", () => {
		expect(LEADING_COMMANDS.slice(0, 3)).toEqual(["write", "research", "search"]);
		expect(new Set(LEADING_COMMANDS).size).toBe(LEADING_COMMANDS.length);
	});
});
