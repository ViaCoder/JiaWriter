// Offline smoke test of a WriterAgent build: --version, --help, one print-mode run against a local
// mock Chat Completions server (API detection probes and one streamed reply), and one run where the
// mock calls import_document on a PDF and export_document on a draft. Checks the reply, the tools and
// the writing prompt with the built-in skills in the request, the parsed PDF and the .docx, and that
// the dummy key appears in no output and no file. No real model, no network beyond 127.0.0.1.
// Usage: node scripts/writer-smoke.mjs <program> [program args...]
//   e.g. node scripts/writer-smoke.mjs ./writeragent

// Child processes.
import { spawn } from "node:child_process";
// Files.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// Mock server.
import { createServer } from "node:http";
// Temp folder.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// Entry-point check.
import { fileURLToPath } from "node:url";

/** Text the mock model replies with. */
export const REPLY = "冒烟测试回复";
/** Dummy key; it must appear nowhere in the output. */
export const SECRET = "sk-smoke-0000-dummy";
/** Tools the writing agent must offer. */
export const TOOLS = ["export_document", "import_document", "read", "style_check", "web_search", "write"];

/** A minimal one-page PDF with an ASCII text line (Helvetica). */
export function onePagePdf(text) {
	// Objects: catalog, page tree, font, page, content stream.
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	// Body with offsets, then the cross-reference table.
	let out = "%PDF-1.4\n";
	const offsets = objs.map((o, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/** SSE events of one Chat Completions turn: a tool call or a text reply. */
function turnEvents(step) {
	// Chunk helper.
	const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	if (step.tool) {
		const call = { index: 0, id: `call_${step.tool}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } };
		return [chunk({ role: "assistant", tool_calls: [call] }, null), chunk({}, "tool_calls"), "data: [DONE]\n\n"];
	}
	return [chunk({ role: "assistant", content: step.text }, null), chunk({}, "stop"), "data: [DONE]\n\n"];
}

/** A mock server: probes get a validation error; real requests follow the script (default: one text reply each). */
export function startMock(script = []) {
	// Bodies of the real requests.
	const requests = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			// Only Chat Completions is served; the other APIs answer 404 so detection moves on.
			if ((req.url ?? "").split("?")[0] !== "/v1/chat/completions") return void res.writeHead(404).end("not found");
			if (req.headers.authorization !== `Bearer ${SECRET}`) return void res.writeHead(401).end("{}");
			const body = JSON.parse(raw || "{}");
			// Probes ask for 0 output tokens: reject them at validation, like the real APIs.
			if (body.max_tokens === 0) return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"invalid request: output limit must be positive"}}');
			requests.push(body);
			// The next scripted turn, or the plain reply.
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const e of turnEvents(script.shift() ?? { text: REPLY })) res.write(e);
			res.end();
		});
	});
	// Listen on a free loopback port.
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

/** Run the program once (in cwd when given); resolves with exit code and output. */
export function run(cmd, args, env, timeoutMs = 120_000, cwd = undefined) {
	// No shell; output collected.
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: String(e) });
		});
	});
}

/** True when any file under dir contains text. */
function anyFileContains(dir, text) {
	// Walk the folder.
	for (const n of readdirSync(dir)) {
		const p = join(dir, n);
		if (statSync(p).isDirectory() ? anyFileContains(p, text) : readFileSync(p, "latin1").includes(text)) return true;
	}
	return false;
}

/** A program path with a folder becomes absolute (the import round runs in another folder); a bare command stays. */
export function programPath(cmd) {
	// Separators of either kind mark a path.
	return /[\\/]/.test(cmd) ? resolve(cmd) : cmd;
}

/** All checks; returns [name, ok, detail] rows. */
export async function smoke(command, args) {
	// The program as an absolute path when one was given.
	const cmd = programPath(command);
	// Isolated home and agent folder; no WA_* or PI_* from the caller.
	const home = mkdtempSync(join(tmpdir(), "wa-smoke-"));
	const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WA_|PI_|SF_)/.test(k)));
	const env = { ...base, HOME: home, USERPROFILE: home, WA_DIR: join(home, "agent") };
	const rows = [];
	const mock = await startMock();
	try {
		// Version and help.
		const v = await run(cmd, [...args, "--version"], env);
		rows.push(["--version", v.code === 0 && /\d+\.\d+\.\d+/.test(v.stdout), v.stdout.trim().split("\n")[0] ?? ""]);
		const h = await run(cmd, [...args, "--help"], env);
		rows.push(["--help", h.code === 0 && h.stdout.includes("writing assistant"), ""]);
		// One print-mode run against the mock.
		const p = await run(cmd, [...args, "-p", "写一句话"], { ...env, WA_URL: mock.url, WA_KEY: SECRET, WA_MODEL: "smoke-model" });
		rows.push(["print reply", p.code === 0 && p.stdout.includes(REPLY), p.code === 0 ? "" : p.stderr.trim().slice(-300)]);
		const body = mock.requests.at(-1) ?? {};
		const names = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
		rows.push(["writing tools", TOOLS.every((t) => names.includes(t)), names.join(",")]);
		const system = JSON.stringify(body.messages?.[0] ?? "");
		rows.push(["writing prompt", system.includes("expert writing assistant"), ""]);
		rows.push(["built-in skills", system.includes("report-analysis"), ""]);
		rows.push(["key hidden", !p.stdout.includes(SECRET) && !p.stderr.includes(SECRET) && !anyFileContains(home, SECRET), ""]);
		// Import a PDF and export a .docx through tool calls (pdf.js, docx and fflate inside the build).
		const work = join(home, "work");
		mkdirSync(join(work, "参考资料"), { recursive: true });
		writeFileSync(join(work, "参考资料", "a.pdf"), onePagePdf("Smoke reference text for the import check, 2026."));
		writeFileSync(join(work, "d.md"), "# 标题\n\n正文, 测试.\n");
		const tools = await startMock([
			{ tool: "import_document", args: { path: "参考资料/a.pdf" } },
			{ tool: "export_document", args: { path: "d.md" } },
			{ text: REPLY },
		]);
		try {
			const t = await run(cmd, [...args, "-p", "导入并导出"], { ...env, WA_URL: tools.url, WA_KEY: SECRET, WA_MODEL: "smoke-model" }, 120_000, work);
			const parsed = join(work, "参考资料", ".parsed", "a.pdf.md");
			rows.push(["import pdf", t.code === 0 && existsSync(parsed) && readFileSync(parsed, "utf-8").includes("Smoke reference text"), t.code === 0 ? "" : t.stderr.trim().slice(-300)]);
			const docx = join(work, "d.docx");
			rows.push(["export docx", existsSync(docx) && readFileSync(docx).subarray(0, 2).toString("latin1") === "PK", ""]);
		} finally {
			tools.server.close();
		}
	} finally {
		mock.server.close();
		rmSync(home, { recursive: true, force: true });
	}
	return rows;
}

// Command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Program and its arguments.
	const [cmd, ...args] = process.argv.slice(2);
	if (!cmd) {
		console.error("usage: node scripts/writer-smoke.mjs <program> [program args...]");
		process.exit(2);
	}
	const rows = await smoke(cmd, args);
	for (const [name, ok, detail] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
	process.exit(rows.every((r) => r[1]) ? 0 : 1);
}
