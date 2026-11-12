// Box: its padding rows can be changed after construction (JiaWriter shows tool calls without padding rows once they
// have no background band).
import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";

describe("Box.setPaddingY", () => {
	it("adds and removes the empty rows above and below the content", () => {
		const box = new Box(1, 1);
		box.addChild(new Text("内容", 0, 0));
		assert.strictEqual(box.render(20).length, 3);
		box.setPaddingY(0);
		assert.strictEqual(box.render(20).length, 1);
		box.setPaddingY(2);
		assert.strictEqual(box.render(20).length, 5);
	});
});
