// Functional test: the writing checks end to end. The CLI runs from source in print mode against
// a local Chat Completions mock that asks for a tool call, so the real tool runs on a real file
// and its result travels back to the model. Nothing leaves 127.0.0.1.

// Child process for the CLI.
import { spawn } from "node:child_process";
// Temp directories and the draft file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// Local HTTP mock.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// --import needs a file:// URL.
import { pathToFileURL } from "node:url";
// Test API.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// CLI entry in the source tree.
const cliPath = resolve(__dirname, "../../src/cli.ts");
// Loader that runs the TypeScript sources.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../src/experimental/source-resolver.ts")).href;
// Key the mock accepts.
const SECRET = "sk-wa-tools-e2e-4711";
// Final reply after the tool result.
const DONE_TEXT = "检查完毕";
// Draft with a contrast frame and a stock phrase.
const DRAFT = "# 草稿\n数字经济不是技术升级，而是深刻变革。\n综上所述，前景广阔。\n";

// Server state.
let server: Server;
// Base URL of the mock.
let baseUrl = "";
// Request bodies seen in the current test.
let bodies: Record<string, unknown>[] = [];
// Tool the mock asks for, with its arguments.
let toolCall = { name: "style_check", args: { path: "draft.md" } as Record<string, unknown> };
// Temp directories to clean.
const dirs: string[] = [];

/** Write one SSE chunk. */
function chunk(res: ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
	// Chat Completions chunk.
	res.write(
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
	);
}

/** Mock handler: first turn asks for the tool, the turn with its result answers with text. */
function handle(req: IncomingMessage, res: ServerResponse): void {
	// Body text.
	let raw = "";
	// Collect chunks.
	req.on("data", (c) => {
		// Append.
		raw += c;
	});
	// Answer when complete.
	req.on("end", () => {
		// Wrong route or key.
		if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${SECRET}`) {
			// Reject.
			res.writeHead(404).end();
			return;
		}
		// Parsed body.
		const body = JSON.parse(raw) as { messages?: { role: string }[] };
		// Remember it.
		bodies.push(body);
		// Event stream.
		res.writeHead(200, { "content-type": "text/event-stream" });
		// The tool result is in the history: answer with text.
		if (body.messages?.some((m) => m.role === "tool")) {
			// Text reply.
			chunk(res, { role: "assistant", content: DONE_TEXT }, null);
			// Finished.
			chunk(res, {}, "stop");
		} else {
			// Ask for the tool.
			chunk(
				res,
				{
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
						},
					],
				},
				null,
			);
			// Finished with a tool call.
			chunk(res, {}, "tool_calls");
		}
		// End marker.
		res.write("data: [DONE]\n\n");
		// Close.
		res.end();
	});
}

/** Run the CLI in print mode in dir with extra variables. */
function runCli(dir: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
	// Environment without proxies or inherited model settings.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	// Remove variables that could interfere.
	for (const k of Object.keys(childEnv))
		if (/^(JW_|PI_CODING_AGENT_|HTTPS?_PROXY$|https?_proxy$)/.test(k)) delete childEnv[k];
	// Mock model, fixed API, no reasoning probes, isolated agent directory.
	Object.assign(
		childEnv,
		{
			JW_URL: baseUrl,
			JW_KEY: SECRET,
			JW_MODEL: "m1",
			JW_API: "openai-completions",
			JW_REASONING: "off",
			JW_DIR: join(dir, ".agent"),
		},
		env,
	);
	// Wrap the child process.
	return new Promise((done, reject) => {
		// Print mode.
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "-p", "检查草稿"], {
			cwd: dir,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Collected stdout.
		let stdout = "";
		// Capture it.
		child.stdout.on("data", (c) => {
			// Append.
			stdout += c;
		});
		// Drain stderr.
		child.stderr.resume();
		// Spawn errors.
		child.on("error", reject);
		// Finished.
		child.on("close", (code) => done({ code, stdout }));
	});
}

/** Working directory with the draft. */
function draftDir(): string {
	// Temp directory.
	const dir = mkdtempSync(join(tmpdir(), "wa-tools-e2e-"));
	// Clean up later.
	dirs.push(dir);
	// The draft.
	writeFileSync(join(dir, "draft.md"), DRAFT);
	// Path.
	return dir;
}

// Start the mock once.
beforeAll(async () => {
	// Server.
	server = createServer(handle);
	// Random loopback port.
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	// Base URL.
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
// Stop it.
afterAll(() => server.close());
// Reset per test.
afterEach(() => {
	// Forget requests.
	bodies = [];
	// Default tool call.
	toolCall = { name: "style_check", args: { path: "draft.md" } };
	// Remove directories.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writing checks end to end", () => {
	it("declares the three tools and returns the style_check report to the model in Chinese", async () => {
		// Run.
		const { code, stdout } = await runCli(draftDir(), {});
		// Success with the final reply.
		expect([code, stdout.trim()]).toEqual([0, DONE_TEXT]);
		// Two model requests: the tool call and the answer.
		expect(bodies.length).toBe(2);
		// Declared tool names.
		const names = (bodies[0].tools as { function: { name: string } }[]).map((t) => t.function.name);
		// The three checks next to the default tools.
		expect(names).toEqual(expect.arrayContaining(["style_check", "word_count", "readability_check", "read", "edit"]));
		// The system prompt lists them.
		expect(JSON.stringify(bodies[0].messages)).toContain("- readability_check: Find rare Chinese characters");
		// Second request carries the report.
		const history = JSON.stringify(bodies[1].messages);
		// Contrast frame with its position.
		expect(history).toContain("第 2 行第 5 列〔对比框架 不是……而是〕不是技术升级，而是");
		// Stock phrase.
		expect(history).toContain("〔套话〕综上所述");
	}, 30_000);
	it("follows JW_LANG=en for the word_count report", async () => {
		// Ask for word_count with a target.
		toolCall = { name: "word_count", args: { path: "draft.md", target: 100 } };
		// Run in English.
		const { code } = await runCli(draftDir(), { JW_LANG: "en" });
		// Success.
		expect(code).toBe(0);
		// English report in the second request: 草稿 2 + 16 + 8 Han characters = 26.
		expect(JSON.stringify(bodies[1].messages)).toContain("Total 26 (Chinese characters 26");
	}, 30_000);
});
