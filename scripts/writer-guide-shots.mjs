#!/usr/bin/env node
// JiaWriter: screenshots for the Chinese install guide (使用说明.html). Starts Chrome for Testing
// headless with a Chinese interface and a temp profile, opens chrome://extensions, marks the control
// to click with a red frame and a step number, and saves three PNGs:
//   1-devmode.png  the 开发者模式 switch      2-load.png  the 加载未打包的扩展程序 button
//   3-loaded.png   the JiaWriter card once the extension is loaded
// Usage: node scripts/writer-guide-shots.mjs <chrome-for-testing> <out-dir>
// Nothing touches the user's Chrome; the extension is copied to /tmp/jiawriter/chrome-extension so the
// card shows a neutral path.

// Chrome process.
import { spawn } from "node:child_process";
// Files.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// Temp folder.
import { tmpdir } from "node:os";
// Paths.
import { dirname, join, resolve } from "node:path";
// This script's folder.
import { fileURLToPath } from "node:url";

// Repository root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The extension in the repository.
const EXT_SRC = join(ROOT, "search_fetch/src/search_fetch/extension");
// Neutral copy shown on the card.
const EXT_SHOWN = "/tmp/jiawriter/chrome-extension";

/** A pause. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start Chrome for Testing headless in Chinese; resolves {proc, port}. */
async function startChrome(chrome, profile, extraArgs) {
	// --no-sandbox: Ubuntu's AppArmor refuses an unpacked Chrome for Testing sandbox (local tool only).
	const args = ["--headless=new", "--no-sandbox", "--lang=zh-CN", "--accept-lang=zh-CN", `--user-data-dir=${profile}`,
		"--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--window-size=1100,720", ...extraArgs, "about:blank"];
	rmSync(join(profile, "DevToolsActivePort"), { force: true });
	const proc = spawn(chrome, args, { stdio: "ignore", detached: true, env: { ...process.env, LANGUAGE: "zh_CN", LANG: "zh_CN.UTF-8" } });
	// Chrome writes its port to DevToolsActivePort (a file left by an earlier run is removed first).
	const file = join(profile, "DevToolsActivePort");
	for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
	const port = Number(readFileSync(file, "utf-8").split("\n")[0]);
	return { proc, port };
}

/** A DevTools protocol session on a new chrome://extensions tab. */
async function openExtensionsPage(port) {
	// New tab.
	const t = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome://extensions`, { method: "PUT" })).json();
	const ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	// Request/response by id.
	let id = 0;
	const waiting = new Map();
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.id && waiting.has(m.id)) {
			waiting.get(m.id)(m);
			waiting.delete(m.id);
		}
	});
	const send = (method, params = {}) =>
		new Promise((res, rej) => {
			const n = ++id;
			waiting.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	// A fixed page size and time to render.
	await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 490, deviceScaleFactor: 1, mobile: false });
	await sleep(1500);
	return { send, close: () => ws.close() };
}

/** Run page code (as a string expression) and return its value. */
async function evaluate(s, expression) {
	// By value, awaiting promises.
	const r = await s.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	return r.result.value;
}

// Page code: find an element through the shadow roots of chrome://extensions and mark it.
const MARK = (path, label) => `(() => {
  let el = document.querySelector("extensions-manager");
  for (const sel of ${JSON.stringify(path)}) { el = (el.shadowRoot || el).querySelector(sel); if (!el) return "missing " + sel; }
  const r = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "wa-mark";
  box.style.cssText = "position:fixed;z-index:99999;pointer-events:none;border:4px solid #e53935;border-radius:10px;"
    + "left:" + (r.left - 8) + "px;top:" + (r.top - 6) + "px;width:" + (r.width + 8) + "px;height:" + (r.height + 4) + "px";
  const tag = document.createElement("div");
  tag.className = "wa-mark";
  tag.textContent = ${JSON.stringify(label)};
  tag.style.cssText = "position:fixed;z-index:99999;background:#e53935;color:#fff;font:bold 20px sans-serif;border-radius:16px;"
    + "padding:4px 12px;left:" + Math.min(r.left, innerWidth - 56) + "px;top:" + (r.bottom + 10) + "px";
  document.body.append(box, tag);
  return "ok";
})()`;

/** Save a screenshot of the page. */
async function shot(s, file) {
	// PNG of the viewport.
	const { data } = await s.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(file, Buffer.from(data, "base64"));
	console.log(`wrote ${file}`);
}

/** Remove the marks (before the next step). */
const UNMARK = `document.querySelectorAll(".wa-mark").forEach((e) => e.remove())`;

// Arguments.
const [chrome, outDir] = process.argv.slice(2);
if (!chrome || !outDir) {
	console.error("usage: node scripts/writer-guide-shots.mjs <chrome-for-testing> <out-dir>");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "wa-shots-"));
try {
	// Run 1: developer mode off, then on.
	let c = await startChrome(chrome, profile, []);
	let s = await openExtensionsPage(c.port);
	const toolbar = ["extensions-toolbar"];
	console.log(await evaluate(s, MARK([...toolbar, "#devMode"], "1")));
	await shot(s, join(outDir, "1-devmode.png"));
	await evaluate(s, UNMARK);
	await evaluate(s, `(() => { const t = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot.querySelector("#devMode"); t.click(); return t.checked; })()`);
	await sleep(1200);
	console.log(await evaluate(s, MARK([...toolbar, "#loadUnpacked"], "2")));
	await shot(s, join(outDir, "2-load.png"));
	s.close();
	process.kill(-c.proc.pid, "SIGTERM");
	await sleep(2000);
	// Run 2: the extension loaded from the neutral path (developer mode stays on in the profile).
	rmSync(EXT_SHOWN, { recursive: true, force: true });
	cpSync(EXT_SRC, EXT_SHOWN, { recursive: true });
	c = await startChrome(chrome, profile, [`--load-extension=${EXT_SHOWN}`]);
	s = await openExtensionsPage(c.port);
	await sleep(1000);
	console.log(await evaluate(s, MARK(["extensions-item-list", "extensions-item"], "3")));
	await shot(s, join(outDir, "3-loaded.png"));
	s.close();
	process.kill(-c.proc.pid, "SIGKILL");
} finally {
	await sleep(500);
	rmSync(profile, { recursive: true, force: true });
	rmSync(dirname(EXT_SHOWN), { recursive: true, force: true });
}
