// Tests for scripts/writer-guide.mjs (node:test): each package's guide carries only its own system's
// commands, embeds the three screenshots, names Chrome's buttons as Chrome shows them in Chinese, and
// keeps Chinese punctuation in its text.

// Test API.
import assert from "node:assert/strict";
import { test } from "node:test";
// Module under test.
import { esc, guideHtml, img, systemParts } from "./writer-guide.mjs";

// Every package platform.
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64", "windows-arm64"];

test("esc and img escape text and embed a PNG", () => {
	// Special characters.
	assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
	// A data URL with the PNG signature.
	const tag = img("1-devmode.png", "开发者模式");
	assert.ok(tag.startsWith('<img src="data:image/png;base64,iVBORw0KGgo'));
	assert.ok(tag.endsWith('alt="开发者模式">'));
});

test("systemParts gives each system its own commands", () => {
	// Windows: setx and the exe; no shell startup files.
	const w = systemParts("windows-arm64");
	assert.equal(w.system, "Windows");
	assert.ok(w.env.includes("setx JW_URL") && w.run.includes("jiawriter.exe") && w.safety.includes("仍要运行"));
	assert.equal(w.pick, "选择文件夹");
	// macOS: zsh, quarantine removal.
	const m = systemParts("darwin-arm64");
	assert.ok(m.env.includes("~/.zshrc") && m.safety.includes("xattr -dr com.apple.quarantine"));
	// Linux: bash, no safety step.
	const l = systemParts("linux-x64");
	assert.ok(l.env.includes("~/.bashrc") && l.safety === "" && l.run.includes("./jiawriter"));
});

test("every guide has the six steps, the three screenshots and Chrome's real button names", () => {
	for (const p of PLATFORMS) {
		const html = guideHtml(p);
		// Six numbered sections.
		for (let i = 1; i <= 6; i++) assert.ok(html.includes(`<h2>${i}. `), `${p} step ${i}`);
		// Three embedded images.
		assert.equal(html.match(/data:image\/png;base64,/g)?.length, 3, p);
		// Chinese Chrome 156: 开发者模式 and 加载未打包的扩展程序; the folder to choose.
		assert.ok(html.includes("开发者模式") && html.includes("加载未打包的扩展程序") && html.includes("chrome-extension"), p);
		assert.ok(!html.includes("加载已解压"), p);
		// Only this system's commands.
		assert.equal(html.includes("setx "), p.startsWith("windows-"), p);
		assert.equal(html.includes("xattr "), p.startsWith("darwin-"), p);
		// No ASCII comma, colon, semicolon or parenthesis next to a Chinese character in the text.
		const text = html.replace(/<pre>[\s\S]*?<\/pre>|<[^>]+>|data:[^"]+/g, "");
		assert.equal(/[\p{Script=Han}][,:;()]|[,:;()][\p{Script=Han}]/u.test(text), false, p);
	}
});
