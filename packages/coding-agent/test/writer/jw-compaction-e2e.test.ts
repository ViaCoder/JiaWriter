// Functional test: compaction through the real provider path, against a local mock of the API. It proves
// what the faux provider cannot: the key held in memory reaches the summary request, and that request
// goes through the output clamp without reasoning. Nothing leaves 127.0.0.1.

// Child process for the CLI.
import { spawn } from "node:child_process";
// Temp directories.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// Local HTTP mock.
import { createServer, type Server } from "node:http";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// --import needs a file:// URL.
import { pathToFileURL } from "node:url";
// Test API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CLI entry in the source tree.
const cliPath = resolve(__dirname, "../../src/cli.ts");
// Loader that runs the TypeScript sources.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../src/experimental/source-resolver.ts")).href;
// Key the mock accepts.
const SECRET = "sk-jw-compact-4711";
// Window of the test: the messages below pass the compaction threshold on the third. It is small because
// the messages travel on the command line, which Windows limits to about 32000 characters.
const CTX = 8000;

/** One request the mock answered. */
interface Seen {
	key: string;
	summary: boolean;
	body: Record<string, unknown>;
}

let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
// When true, summary requests fail as a broken gateway would.
let refuseSummary = false;

/** Stream a short Chat Completions reply. */
function reply(res: import("node:http").ServerResponse, text: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta: unknown, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	res.write(chunk({ role: "assistant", content: text }, null));
	res.write(chunk({}, "stop"));
	res.end("data: [DONE]\n\n");
}

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "{}") as Record<string, unknown>;
			// Detection and reasoning probes ask for no output.
			if (body.max_tokens === 0 || body.max_completion_tokens === 0) {
				res.writeHead(req.url?.includes("chat/completions") ? 400 : 404).end(
					'{"error":{"message":"invalid request"}}',
				);
				return;
			}
			const summary = raw.includes("context summarization assistant");
			seen.push({ key: String(req.headers.authorization ?? ""), summary, body });
			if (summary && refuseSummary) {
				res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"summary refused"}}');
				return;
			}
			reply(res, summary ? "摘要：用户要求写城市绿化报告。" : "好的。");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

/** Print mode with long messages, so the oldest leaves the kept 20000 tokens; returns exit code and output. */
async function run(): Promise<{ code: number | null; out: string }> {
	const dir = mkdtempSync(join(tmpdir(), "jw-compact-"));
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of Object.keys(env)) if (/^(JW_|PI_CODING_AGENT_|HTTPS?_PROXY$|https?_proxy$)/.test(k)) delete env[k];
	Object.assign(env, {
		JW_DIR: dir,
		JW_URL: baseUrl,
		JW_KEY: SECRET,
		JW_MODEL: "m1",
		JW_API: "openai-completions",
		JW_CTX: String(CTX),
		JW_EFFORT: "high",
		JW_AUTO_EXPORT: "off",
	});
	// A small window needs small kept and reserved parts too.
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ compaction: { reserveTokens: 1000, keepRecentTokens: 2000 } }),
	);
	const page = "城市绿化研究资料".repeat(300);
	const out = await new Promise<{ code: number | null; out: string }>((done, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				sourceResolverUrl,
				cliPath,
				"-p",
				`写城市绿化报告。${page}`,
				`第二段。${page}`,
				`第三段。${page}`,
				"最后一句",
			],
			{ cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let text = "";
		child.stdout.on("data", (c) => {
			text += c;
		});
		child.stderr.on("data", (c) => {
			text += c;
		});
		child.on("error", reject);
		child.on("close", (code) => done({ code, out: text }));
	});
	rmSync(dir, { recursive: true, force: true });
	return out;
}

describe("compaction through the real provider", () => {
	it("sends the summary request with the key from memory, clamped, without reasoning", async () => {
		seen.length = 0;
		refuseSummary = false;
		const r = await run();
		expect(r.code).toBe(0);
		const summaries = seen.filter((s) => s.summary);
		expect(summaries.length).toBeGreaterThan(0);
		for (const s of summaries) {
			expect(s.key).toBe(`Bearer ${SECRET}`);
			expect(s.body.reasoning_effort).toBeUndefined();
			// Output limit inside the window.
			const limit = Number(s.body.max_completion_tokens ?? s.body.max_tokens ?? 0);
			expect(limit).toBeLessThan(CTX);
		}
		// The key never reaches the output.
		expect(r.out).not.toContain(SECRET);
	}, 60_000);

	it("finishes every message when the gateway refuses summaries", async () => {
		seen.length = 0;
		refuseSummary = true;
		const r = await run();
		expect(r.code).toBe(0);
		// Three conversation requests were answered after the failed summaries.
		expect(seen.filter((s) => !s.summary).length).toBeGreaterThanOrEqual(3);
		expect(seen.some((s) => s.summary)).toBe(true);
		expect(JSON.stringify(seen.at(-1)?.body)).toContain("本地摘要");
	}, 60_000);
});
