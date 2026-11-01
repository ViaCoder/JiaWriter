// Tests for scripts/writer-smoke.mjs (node:test): the mock server and the checks, driven by a fake
// program that behaves like writeragent (or leaks the key). Loopback only.

// Assertions.
import assert from "node:assert/strict";
// Files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// Temp folder.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// Test runner.
import { after, before, test } from "node:test";
// Functions under test.
import { onePagePdf, programPath, REPLY, run, SECRET, smoke, startMock, TOOLS } from "./writer-smoke.mjs";

// Folder of the fake programs.
let dir = "";
before(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-smoketest-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fake program: version, help, and one Chat Completions request in print mode. */
function fake(leak) {
	// Node script answering like writeragent.
	const p = join(dir, leak ? "leaky.mjs" : "good.mjs");
	writeFileSync(
		p,
		`const a = process.argv.slice(2);
if (a[0] === "--version") console.log("1.4.0");
else if (a[0] === "--help") console.log("writeragent - AI writing assistant");
else if (a[1] === "导入并导出") {
  const fs = await import("node:fs");
  fs.mkdirSync("参考资料/.parsed", { recursive: true });
  fs.writeFileSync("参考资料/.parsed/a.pdf.md", "Smoke reference text");
  fs.writeFileSync("d.docx", "PK fake");
  console.log(${JSON.stringify(REPLY)});
} else {
  const body = { max_tokens: 100, messages: [{ role: "system", content: "You are an expert writing assistant. <name>report-analysis</name>" }],
    tools: ${JSON.stringify(TOOLS)}.map((name) => ({ type: "function", function: { name } })) };
  const res = await fetch(process.env.WA_URL + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + process.env.WA_KEY }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(text.includes(${JSON.stringify(REPLY)}) ? ${JSON.stringify(REPLY)} : "no reply");
  ${leak ? "console.error(process.env.WA_KEY);" : ""}
}
`,
	);
	return p;
}

test("the mock rejects probes and bad keys, routes only Chat Completions, and streams the reply", async () => {
	// Server.
	const mock = await startMock();
	try {
		const post = (path, key, body) => fetch(mock.url + path, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
		assert.equal((await post("/v1/messages", SECRET, {})).status, 404);
		assert.equal((await post("/v1/chat/completions", "wrong", {})).status, 401);
		assert.equal((await post("/v1/chat/completions", SECRET, { max_tokens: 0 })).status, 400);
		const ok = await post("/v1/chat/completions", SECRET, { max_tokens: 5 });
		assert.ok((await ok.text()).includes(REPLY));
		assert.equal(mock.requests.length, 1);
	} finally {
		mock.server.close();
	}
});

test("run collects output and exit code, and reports a missing program", async () => {
	// A child that prints and exits 3.
	const r = await run(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], process.env);
	assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim()], [3, "out", "err"]);
	const missing = await run(join(dir, "no-such-program"), [], process.env);
	assert.equal(missing.code, -1);
});

test("smoke passes a well-behaved program and fails one that leaks the key", async () => {
	// All checks pass.
	const good = await smoke(process.execPath, [fake(false)]);
	assert.deepEqual(good.map(([name, ok]) => [name, ok]), [
		["--version", true],
		["--help", true],
		["print reply", true],
		["writing tools", true],
		["writing prompt", true],
		["built-in skills", true],
		["key hidden", true],
		["import pdf", true],
		["export docx", true],
	]);
	// The key on stderr fails the key check.
	const leaky = await smoke(process.execPath, [fake(true)]);
	assert.deepEqual(leaky.find(([name]) => name === "key hidden"), ["key hidden", false, ""]);
});

test("onePagePdf writes a PDF whose xref offsets point at its objects", () => {
	// Each object starts where the table says.
	const pdf = onePagePdf("Hello");
	const offsets = pdf.slice(pdf.indexOf("xref")).match(/^\d{10} 00000 n $/gm).map((l) => Number(l.slice(0, 10)));
	offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o)));
	assert.ok(pdf.includes("(Hello) Tj"));
});

test("the mock follows a script of tool calls before the plain reply", async () => {
	// Two scripted turns.
	const mock = await startMock([{ tool: "import_document", args: { path: "a.pdf" } }]);
	try {
		const post = () => fetch(`${mock.url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: "{}" }).then((r) => r.text());
		const first = await post();
		assert.ok(first.includes('"name":"import_document"') && first.includes('"finish_reason":"tool_calls"'));
		assert.ok((await post()).includes(REPLY));
	} finally {
		mock.server.close();
	}
});

test("programPath makes a relative program path absolute and keeps a bare command", () => {
	// CI passes extracted/writeragent/writeragent; the import round runs in another folder.
	assert.equal(programPath("extracted/writeragent/writeragent"), resolve("extracted/writeragent/writeragent"));
	assert.equal(programPath("extracted\\writeragent.exe"), resolve("extracted\\writeragent.exe"));
	assert.equal(programPath("node"), "node");
});
