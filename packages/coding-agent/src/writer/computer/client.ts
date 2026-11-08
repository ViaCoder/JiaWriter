/** A small stdio client for the driver: one JSON-RPC line out, one line back, one call at a time. */

// The driver process.
import { spawn } from "node:child_process";
// The home directory, kept out of what is shown.
import { homedir } from "node:os";
// Lines of its output.
import { createInterface } from "node:readline";
// Its pipes.
import type { Readable, Writable } from "node:stream";

/** A tool's answer. */
export interface DriverReply {
	// The machine-readable result.
	structured: Record<string, unknown>;
	// The words.
	text: string;
	// True when the call failed or was refused.
	failed: boolean;
	// A picture, when the tool gave one.
	image?: { data: string; mimeType: string };
}

/** The driver as the tool sees it. */
export interface DriverClient {
	call(tool: string, args: Record<string, unknown>): Promise<DriverReply>;
	close(): void;
}

/** Longest a call may take (ms). */
const CALL_MS = 25_000;
/** The protocol version spoken. */
const PROTOCOL = "2025-03-26";

/** One content block of a tool result. */
interface ToolBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** A tool result in the shape used here. */
export function driverReply(result: {
	content?: ToolBlock[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}): DriverReply {
	const content = result.content ?? [];
	const image = content.find((c) => c.type === "image" && c.data);
	return {
		structured: result.structuredContent ?? {},
		text: content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n"),
		failed: !!result.isError,
		...(image ? { image: { data: image.data as string, mimeType: image.mimeType ?? "image/png" } } : {}),
	};
}

/** Longest part of the driver's last complaint that is kept (characters). */
const REASON_CHARS = 300;

/** Why the driver stopped, from its last line of errors, with the home directory shown as ~. */
export function stopReason(lastLine: string, home: string): string {
	// Without a line, nothing more is known.
	const line = lastLine.trim().slice(0, REASON_CHARS);
	if (!line) return "driver stopped";
	// The account's path is nobody else's business.
	return `driver stopped: ${home ? line.split(home).join("~") : line}`;
}

/** What is used of a running driver. */
export interface DriverProcess {
	stdin: Writable;
	stdout: Readable;
	// Its errors, when they are kept: the last line says why it stopped.
	stderr?: Readable | null;
	on(event: "exit" | "error", listener: () => void): unknown;
	kill(): unknown;
}

/** Talk to a running driver. */
export async function connectDriver(child: DriverProcess): Promise<DriverClient> {
	const waiting = new Map<number, (reply: unknown) => void>();
	let next = 0;
	createInterface({ input: child.stdout }).on("line", (line) => {
		try {
			const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
			if (message.id !== undefined) waiting.get(message.id)?.(message);
		} catch {
			// A line that is not the protocol.
		}
	});
	// The last line the driver complained with.
	let lastLine = "";
	if (child.stderr)
		createInterface({ input: child.stderr }).on("line", (line) => {
			if (line.trim()) lastLine = line;
		});
	// The driver gone, or never there: nothing more will come.
	let stopped = false;
	const stop = () => {
		stopped = true;
		for (const done of waiting.values()) done({ error: { message: stopReason(lastLine, homedir()) } });
	};
	child.on("exit", stop);
	child.on("error", stop);
	/** One request. */
	const request = (method: string, params: unknown) =>
		new Promise<{ result?: unknown; error?: { message?: string } }>((done, fail) => {
			if (stopped) return done({ error: { message: stopReason(lastLine, homedir()) } });
			const id = ++next;
			const timer = setTimeout(() => fail(new Error("driver: no reply")), CALL_MS);
			waiting.set(id, (reply) => {
				clearTimeout(timer);
				waiting.delete(id);
				done(reply as { result?: unknown; error?: { message?: string } });
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const greeted = await request("initialize", {
		protocolVersion: PROTOCOL,
		capabilities: {},
		clientInfo: { name: "jiawriter", version: "1" },
	});
	if (greeted.error) throw new Error(greeted.error.message);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	return {
		async call(tool, args) {
			const { result, error } = await request("tools/call", { name: tool, arguments: args });
			if (error) throw new Error(error.message ?? "driver error");
			return driverReply(result as Parameters<typeof driverReply>[0]);
		},
		close: () => void child.kill(),
	};
}

/** Start the driver; its errors are read, so it can say why it stopped. */
export function startDriver(path: string, env: NodeJS.ProcessEnv): Promise<DriverClient> {
	return connectDriver(spawn(path, ["mcp"], { env, stdio: ["pipe", "pipe", "pipe"] }));
}
