// Functional test: JW_* configuration end to end against a local mock of the three APIs.
// The CLI runs from source in print mode; nothing leaves 127.0.0.1.

// Child process for the CLI.
import { spawn } from "node:child_process";
// Temp directories and file scans.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
// Key the mock accepts; it must never appear in files or output.
const SECRET = "sk-wa-e2e-secret-4711";
// Text every mocked API streams back.
const REPLY = "你好，世界";
// Small context window so the output clamp is visible.
const CTX = 20_000;

/** Which routes the mock serves. */
type MockApi = "anthropic-messages" | "openai-responses" | "openai-completions";
/** Route path of each API. */
const PATHS: Record<MockApi, string> = {
	// Anthropic Messages.
	"anthropic-messages": "/v1/messages",
	// OpenAI Responses.
	"openai-responses": "/v1/responses",
	// OpenAI Chat Completions.
	"openai-completions": "/v1/chat/completions",
};

/** One request seen by the mock. */
interface SeenRequest {
	// Request path.
	path: string;
	// Parsed JSON body.
	body: Record<string, unknown>;
	// True for the deliberately invalid detection probe.
	probe: boolean;
}

// Server state shared by the tests.
let server: Server;
// Base URL of the mock.
let baseUrl = "";
// APIs the mock currently supports.
let supported: MockApi[] = [];
// Reasoning levels the mock accepts (all by default).
let acceptedLevels = ["low", "medium", "high", "xhigh", "max"];
// When true, probes cannot see reasoning support (only real requests reject a level).
let probeBlind = false;
// Requests seen in the current test.
let seen: SeenRequest[] = [];
// Temp directories to clean.
const dirs: string[] = [];

/** Tell probes apart from real requests: probes ask for 0 output tokens. */
function isProbe(body: Record<string, unknown>): boolean {
	// Any output limit of 0 marks the probe.
	return body.max_tokens === 0 || body.max_output_tokens === 0;
}

/** Reasoning level carried by a request, in any of the three API forms. */
function levelOf(body: Record<string, unknown>): string | undefined {
	// Responses, Anthropic effort, Chat Completions.
	return (
		(body.reasoning as { effort?: string } | undefined)?.effort ??
		(body.output_config as { effort?: string } | undefined)?.effort ??
		(body.reasoning_effort as string | undefined)
	);
}

/** Detection probes carry no reasoning field. */
function detectionProbes(): SeenRequest[] {
	// Probes without a level and without a thinking budget.
	return seen.filter(
		(s) =>
			s.probe &&
			levelOf(s.body) === undefined &&
			(s.body.thinking as { type?: string } | undefined)?.type !== "enabled",
	);
}

/** Reasoning probes carry a level or a budget. */
function reasoningProbes(): SeenRequest[] {
	// Every other probe.
	return seen.filter((s) => s.probe && !detectionProbes().includes(s));
}

/** Write an SSE stream with the reply text in the format of the given API. */
function streamReply(api: MockApi, res: ServerResponse): void {
	// Event-stream headers.
	res.writeHead(200, { "content-type": "text/event-stream" });
	// Anthropic: named events with JSON data.
	if (api === "anthropic-messages") {
		// The events in order.
		const events: [string, unknown][] = [
			[
				"message_start",
				{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 0 } } },
			],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
			["message_stop", { type: "message_stop" }],
		];
		// Write each event.
		for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	} else if (api === "openai-responses") {
		// Responses: typed data events.
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: REPLY },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "m1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: REPLY }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		// Write each event.
		for (const data of events) res.write(`data: ${JSON.stringify(data)}\n\n`);
	} else {
		// Chat Completions: deltas, a finish chunk and [DONE].
		res.write(
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] })}\n\n`,
		);
		// Finish reason.
		res.write(
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		);
		// End marker.
		res.write("data: [DONE]\n\n");
	}
	// Close the stream.
	res.end();
}

/** Mock request handler. */
function handle(req: IncomingMessage, res: ServerResponse): void {
	// Collect the body.
	let raw = "";
	// Append chunks.
	req.on("data", (chunk) => {
		// Body text.
		raw += chunk;
	});
	// Answer once the body is complete.
	req.on("end", () => {
		// Path without query.
		const path = (req.url ?? "").split("?")[0];
		// Parsed body (empty object on bad JSON).
		const body = (() => {
			try {
				// JSON body.
				return JSON.parse(raw || "{}") as Record<string, unknown>;
			} catch {
				// Not JSON.
				return {};
			}
		})();
		// Remember the request.
		seen.push({ path, body, probe: isProbe(body) });
		// API served at this path, if any.
		const api = (Object.keys(PATHS) as MockApi[]).find((a) => PATHS[a] === path && supported.includes(a));
		// Unknown route.
		if (!api) {
			// 404.
			res.writeHead(404).end("not found");
			return;
		}
		// Key sent by the client.
		const key =
			api === "anthropic-messages"
				? req.headers["x-api-key"]
				: String(req.headers.authorization ?? "").replace(/^Bearer /, "");
		// Wrong key.
		if (key !== SECRET) {
			// 401.
			res.writeHead(401).end('{"error":"unauthorized"}');
			return;
		}
		// Level requested by this request, if any.
		const level = levelOf(body);
		// An unaccepted level is rejected by name (probes only when not blind).
		if (level !== undefined && !acceptedLevels.includes(level) && (!isProbe(body) || !probeBlind)) {
			// 400 naming the reasoning parameter.
			res.writeHead(400, { "content-type": "application/json" }).end(
				`{"error":{"message":"Unsupported value for reasoning effort: ${level}"}}`,
			);
			return;
		}
		// Probe: validation error like the real APIs.
		if (isProbe(body)) {
			// 400 with a validation message.
			res.writeHead(400, { "content-type": "application/json" }).end(
				'{"error":{"message":"invalid request: output limit must be positive"}}',
			);
			return;
		}
		// Real request: stream the reply.
		streamReply(api, res);
	});
}

/** Run the CLI in print mode with the given variables. */
function runCli(
	env: Record<string, string>,
	agentDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	// Environment without proxies or inherited model settings.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	// Remove variables that could interfere.
	for (const k of Object.keys(childEnv))
		if (/^(JW_|PI_CODING_AGENT_|HTTPS?_PROXY$|https?_proxy$)/.test(k)) delete childEnv[k];
	// Isolated agent directory plus the test variables.
	Object.assign(childEnv, { JW_DIR: agentDir }, env);
	// Wrap the child process in a promise.
	return new Promise((done, reject) => {
		// Print mode with a short prompt; stdin closed.
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "-p", "写一句话"], {
			cwd: agentDir,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Collected output.
		let stdout = "";
		let stderr = "";
		// Capture stdout.
		child.stdout.on("data", (c) => {
			// Append.
			stdout += c;
		});
		// Capture stderr.
		child.stderr.on("data", (c) => {
			// Append.
			stderr += c;
		});
		// Spawn errors.
		child.on("error", reject);
		// Finished.
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

/** Fresh agent directory. */
function newAgentDir(): string {
	// Create it.
	const dir = mkdtempSync(join(tmpdir(), "wa-e2e-"));
	// Clean up later.
	dirs.push(dir);
	// Return the path.
	return dir;
}

/** True when any file under dir contains text. */
function anyFileContains(dir: string, text: string): boolean {
	// Walk the tree.
	for (const name of readdirSync(dir)) {
		// Full path.
		const path = join(dir, name);
		// Recurse into directories.
		if (statSync(path).isDirectory()) {
			// Found deeper.
			if (anyFileContains(path, text)) return true;
		} else if (readFileSync(path, "utf-8").includes(text)) {
			// Found in this file.
			return true;
		}
	}
	// Not found.
	return false;
}

/** The real (non-probe) request of the current test. */
function realRequest(): SeenRequest | undefined {
	// First request that is not a probe.
	return seen.find((r) => !r.probe);
}

// Start the mock once.
beforeAll(async () => {
	// HTTP server with the handler.
	server = createServer(handle);
	// Random free port on loopback.
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	// Base URL.
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
// Stop it at the end.
afterAll(() => server.close());
// Reset per-test state.
afterEach(() => {
	// Forget seen requests.
	seen = [];
	// Back to accepting every level.
	acceptedLevels = ["low", "medium", "high", "xhigh", "max"];
	// Probes see reasoning support again.
	probeBlind = false;
	// Delete temp directories.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JW_* end to end", () => {
	it("detects Anthropic Messages, clamps max_tokens and prints the reply", async () => {
		// Only Anthropic is served.
		supported = ["anthropic-messages"];
		// Fresh agent directory.
		const dir = newAgentDir();
		// Run.
		const r = await runCli({ JW_URL: baseUrl, JW_KEY: SECRET, JW_MODEL: "m1", JW_CTX: String(CTX) }, dir);
		// Success with the reply.
		expect([r.code, r.stdout.includes(REPLY)]).toEqual([0, true]);
		// One detection probe and five reasoning probes, then the real request.
		expect([detectionProbes().length, reasoningProbes().length]).toEqual([1, 5]);
		// Adaptive thinking at the default level.
		expect([realRequest()?.body.thinking, realRequest()?.body.output_config]).toMatchObject([
			{ type: "adaptive" },
			{ effort: "medium" },
		]);
		// Output limit lowered from 128000 to fit the 20000 window.
		expect(realRequest()?.body.max_tokens).toBeLessThan(CTX);
		// The user message reaches the model with the time it was sent.
		expect(JSON.stringify(realRequest()?.body.messages)).toMatch(/\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+, /);
		// The request carries the writing system prompt.
		expect(JSON.stringify(realRequest()?.body.system)).toContain(
			"expert writing assistant operating inside JiaWriter",
		);
		// The built-in Chinese writing skills are offered (JW_LANG unset: zh).
		expect(JSON.stringify(realRequest()?.body.system)).toContain("<name>report-analysis</name>");
		expect(JSON.stringify(realRequest()?.body.system)).toContain("用于写企业和研究类的报告、分析和总结");
		// The default writing tools, the four checks, web search, import and export are offered, bash is not.
		expect(((realRequest()?.body.tools as { name: string }[]) ?? []).map((t) => t.name).sort()).toEqual([
			"draft_restore",
			"edit",
			"export_document",
			"find",
			"gongwen_check",
			"grep",
			"import_document",
			"ls",
			"material_add",
			"read",
			"readability_check",
			"style_check",
			"topic_open",
			"web_fetch",
			"web_search",
			"word_count",
			"write",
		]);
		// The key appears nowhere.
		expect([anyFileContains(dir, SECRET), r.stdout.includes(SECRET), r.stderr.includes(SECRET)]).toEqual([
			false,
			false,
			false,
		]);
	}, 90_000);

	it("detects Responses after one miss and clamps max_output_tokens", async () => {
		// Only Responses is served.
		supported = ["openai-responses"];
		// Fresh agent directory.
		const dir = newAgentDir();
		// Run.
		const r = await runCli({ JW_URL: baseUrl, JW_KEY: SECRET, JW_MODEL: "m1", JW_CTX: String(CTX) }, dir);
		// Success with the reply.
		expect([r.code, r.stdout.includes(REPLY)]).toEqual([0, true]);
		// Two detection probes (Anthropic missed, Responses matched).
		expect(detectionProbes().map((s) => s.path)).toEqual(["/v1/messages", "/v1/responses"]);
		// Lowered output limit.
		expect(realRequest()?.body.max_output_tokens).toBeLessThan(CTX);
	}, 90_000);

	it("detects Chat Completions with a /v1 URL, then uses the cache on the next start", async () => {
		// Only Chat is served.
		supported = ["openai-completions"];
		// Fresh agent directory shared by both runs.
		const dir = newAgentDir();
		// First run with a trailing /v1 in the URL.
		const first = await runCli(
			{ JW_URL: `${baseUrl}/v1/`, JW_KEY: SECRET, JW_MODEL: "m1", JW_CTX: String(CTX) },
			dir,
		);
		// Success with the reply after three detection probes.
		expect([first.code, first.stdout.includes(REPLY), detectionProbes().length]).toEqual([0, true, 3]);
		// The Chat request carries a lowered limit in one of its two field names.
		const body = realRequest()?.body ?? {};
		// Whichever field the client used.
		expect(Number(body.max_completion_tokens ?? body.max_tokens)).toBeLessThan(CTX);
		// Forget the first run's requests.
		seen = [];
		// Second run in the same agent directory.
		const second = await runCli(
			{ JW_URL: `${baseUrl}/v1/`, JW_KEY: SECRET, JW_MODEL: "m1", JW_CTX: String(CTX) },
			dir,
		);
		// Cached: no probe, just the real request.
		expect([second.code, seen.filter((s) => s.probe).length, seen.length]).toEqual([0, 0, 1]);
	}, 120_000);

	it("uses the nearest supported reasoning level when JW_EFFORT is unavailable", async () => {
		// Responses that accepts low, medium and high only.
		supported = ["openai-responses"];
		acceptedLevels = ["low", "medium", "high"];
		// Ask for max.
		const r = await runCli({ JW_URL: baseUrl, JW_KEY: SECRET, JW_MODEL: "m1", JW_EFFORT: "max" }, newAgentDir());
		// Success, and the request uses high, the nearest supported level.
		expect([
			r.code,
			r.stdout.includes(REPLY),
			(realRequest()?.body.reasoning as { effort?: string })?.effort,
		]).toEqual([0, true, "high"]);
	}, 90_000);

	it("drops a level the server rejects at run time and uses the next one on the next start", async () => {
		// Probes cannot tell; real requests reject max.
		supported = ["openai-responses"];
		acceptedLevels = ["low", "medium", "high", "xhigh"];
		probeBlind = true;
		// Shared agent directory.
		const dir = newAgentDir();
		// First run at max fails at the real request.
		const first = await runCli({ JW_URL: baseUrl, JW_KEY: SECRET, JW_MODEL: "m1", JW_EFFORT: "max" }, dir);
		// The real request carried max.
		expect((realRequest()?.body.reasoning as { effort?: string })?.effort).toBe("max");
		// Forget the first run.
		seen = [];
		// Second run in the same directory.
		const second = await runCli({ JW_URL: baseUrl, JW_KEY: SECRET, JW_MODEL: "m1", JW_EFFORT: "max" }, dir);
		// The cache dropped max, so the nearest level xhigh is used and the reply arrives.
		expect([
			first.code !== 0 || !first.stdout.includes(REPLY),
			second.code,
			(realRequest()?.body.reasoning as { effort?: string })?.effort,
			second.stdout.includes(REPLY),
		]).toEqual([true, 0, "xhigh", true]);
	}, 120_000);

	it("stops after one request when the key is wrong", async () => {
		// All APIs served, but the key will not match.
		supported = ["anthropic-messages", "openai-responses", "openai-completions"];
		// Run with a wrong key.
		const r = await runCli({ JW_URL: baseUrl, JW_KEY: "wrong-key", JW_MODEL: "m1" }, newAgentDir());
		// Configuration error with the Chinese reason.
		expect([r.code, r.stderr.includes("JW_KEY 无效或没有权限")]).toEqual([1, true]);
		// Exactly one request was sent.
		expect(seen.length).toBe(1);
	}, 90_000);

	it("shows the setup commands and sends nothing when variables are missing", async () => {
		// Anything served.
		supported = ["openai-completions"];
		// Only the URL is set.
		const r = await runCli({ JW_URL: baseUrl }, newAgentDir());
		// Configuration error with the hint.
		// The commands follow the platform (PowerShell on Windows).
		const command = process.platform === "win32" ? "$env:JW_KEY=" : "export JW_KEY=";
		expect([r.code, r.stderr.includes("缺少：JW_KEY、JW_MODEL"), r.stderr.includes(command)]).toEqual([
			1,
			true,
			true,
		]);
		// No request.
		expect(seen.length).toBe(0);
	}, 90_000);
});
