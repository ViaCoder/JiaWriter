/**
 * The link between JiaWriter and the user's own Chrome.
 *
 * - extension: the JiaWriter extension (search_fetch/src/search_fetch/extension) opens pages in a
 *   dedicated window and sends trusted mouse and keyboard input.
 * - host: Chrome starts this program with the extension's origin as the first argument (native
 *   messaging: stdio frames of a 32-bit native-order length plus UTF-8 JSON). The host also listens
 *   locally: a Unix socket in a private folder on Linux and macOS (the sf client uses it too), and a
 *   loopback TCP port guarded by a random token on Windows.
 * - client: every search_web / fetch_web call sends one JSON request line and reads one reply line.
 */

// Token comparison and generation, extension id hashing.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// Private files and folders.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
// Local socket server and client.
import { createConnection, createServer, type Server, type Socket } from "node:net";
// Paths.
import { dirname, join } from "node:path";
// Stream types of stdin and stdout.
import type { Readable, Writable } from "node:stream";

/** Native messaging host name (the extension's background.js connects to it). */
export const HOST_NAME = "com.jiawriter.browser";
/** Chrome's id of the JiaWriter extension (fixed by the key in its manifest.json). */
export const EXTENSION_ID = "mnoicnfoocibanokjfbpmbgpamlmdgje";
/** Largest message the host may send to Chrome (Chrome's limit is 1 MB). */
const MAX_TO_CHROME = 1024 * 1024;
/** Largest request line a client may send (bytes). */
const MAX_REQUEST = 256 * 1024;
/** Default time one request may take (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Shown when Chrome or the extension is not connected. */
export const NOT_CONNECTED = "browser extension not connected";

/** Where the host listens. */
export type BridgeAddress = { kind: "unix"; path: string } | { kind: "tcp"; file: string };

/** Contents of the Windows bridge file: port and token. */
interface TcpInfo {
	// Loopback port.
	port: number;
	// Hex token every request carries.
	token: string;
}

/** Chrome or the extension is not reachable. */
export class BridgeUnavailable extends Error {}

/** The extension answered with an error. */
export class BridgeError extends Error {}

/** Chrome's id for an extension: SHA-256 of its public key, first 32 hex digits mapped 0–f to a–p. */
export function extensionIdFromKey(keyBase64: string): string {
	// Hash of the DER key bytes.
	const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
	// Each hex digit becomes a letter.
	return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/** True when Chrome started this program as the native messaging host (first argument is an extension origin). */
export function isHostArgv(args: readonly string[]): boolean {
	// Chrome passes chrome-extension://<id>/ first (Windows adds --parent-window=… after it).
	return args.length > 0 && args[0].startsWith("chrome-extension://");
}

/** The bridge address for an agent folder: a socket in <agentDir>/browser, or the Windows port file. */
export function bridgeAddress(agentDir: string, platform: NodeJS.Platform): BridgeAddress {
	// Private folder of the bridge.
	const dir = join(agentDir, "browser");
	// Windows has no Unix sockets for sf and Node alike: a loopback port written to a file.
	return platform === "win32"
		? { kind: "tcp", file: join(dir, "bridge.json") }
		: { kind: "unix", path: join(dir, "bridge.sock") };
}

/** One native messaging frame: 32-bit native-order (little-endian on every supported CPU) length plus JSON. */
export function encodeFrame(obj: unknown): Buffer {
	// UTF-8 JSON body.
	const body = Buffer.from(JSON.stringify(obj), "utf-8");
	// Length prefix.
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	// Both.
	return Buffer.concat([head, body]);
}

/** Split complete frames off a buffer: the parsed messages and the unfinished rest. */
export function decodeFrames(buf: Buffer): { messages: unknown[]; rest: Buffer } {
	// Collected messages.
	const messages: unknown[] = [];
	// Read position.
	let at = 0;
	// While a whole frame is present.
	while (buf.length - at >= 4) {
		const len = buf.readUInt32LE(at);
		if (buf.length - at - 4 < len) break;
		// Malformed JSON is skipped.
		try {
			messages.push(JSON.parse(buf.subarray(at + 4, at + 4 + len).toString("utf-8")));
		} catch {
			// Skip it.
		}
		at += 4 + len;
	}
	// Messages and what is left.
	return { messages, rest: buf.subarray(at) };
}

/** Write a file atomically with the given mode (temp file in the same folder, then rename). */
function writePrivate(path: string, text: string, mode: number): void {
	// Temp file.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	// Mode again (umask may have cleared bits).
	chmodSync(tmp, mode);
	// Into place.
	renameSync(tmp, path);
}

/** Equal tokens, compared in constant time. */
export function tokenMatches(given: unknown, expected: string): boolean {
	// Only strings of the same length can match.
	if (typeof given !== "string" || given.length !== expected.length) return false;
	// Constant-time comparison.
	return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Options of the host. */
export interface HostOptions {
	// Frames from Chrome.
	input: Readable;
	// Frames to Chrome.
	output: Writable;
	// Where clients connect.
	address: BridgeAddress;
	// Diagnostic lines (stderr; Chrome shows them in its log).
	log?: (line: string) => void;
}

/** Run the host until Chrome closes stdin; returns after the listener is closed and removed. */
export async function runHost(opts: HostOptions): Promise<void> {
	// Diagnostics.
	const log = opts.log ?? (() => {});
	// Request id → reply callback.
	const pending = new Map<number, (reply: Record<string, unknown>) => void>();
	// Next request id.
	let nextId = 1;
	// Token for Windows clients ("" on Unix sockets, which file permissions protect).
	const token = opts.address.kind === "tcp" ? randomBytes(32).toString("hex") : "";

	/** Forward one request to the extension and wait for the reply. */
	function forward(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		// Id and frame.
		const id = nextId++;
		const frame = encodeFrame({ ...args, id, op });
		// Chrome drops oversized messages.
		if (frame.length - 4 > MAX_TO_CHROME)
			return Promise.resolve({ ok: false, error: "request larger than Chrome's 1 MB limit" });
		// Wait for the reply, bounded.
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({ ok: false, error: "timed out waiting for the extension" });
			}, timeoutMs);
			pending.set(id, (reply) => {
				clearTimeout(timer);
				resolve(reply);
			});
			opts.output.write(frame);
		});
	}

	/** One client connection: one request line in, one reply line out. */
	function onClient(sock: Socket): void {
		// Received bytes.
		let buf: Buffer = Buffer.alloc(0);
		sock.on("data", async (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			// Oversized requests are refused.
			if (buf.length > MAX_REQUEST) {
				sock.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
				return;
			}
			// Wait for the end of the line.
			const nl = buf.indexOf(10);
			if (nl < 0) return;
			const line = buf.subarray(0, nl).toString("utf-8");
			buf = Buffer.alloc(0);
			// Parse, check the token, forward.
			let reply: Record<string, unknown>;
			try {
				const req = JSON.parse(line) as { op?: unknown; args?: unknown; timeout?: unknown; token?: unknown };
				if (token && !tokenMatches(req.token, token)) reply = { ok: false, error: "bad token" };
				else {
					const seconds = Number(req.timeout);
					const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS;
					reply = await forward(String(req.op), (req.args ?? {}) as Record<string, unknown>, ms);
				}
			} catch (e) {
				reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
			// One line back, then close.
			sock.end(`${JSON.stringify(reply)}\n`);
		});
		// A client that went away is not an error.
		sock.on("error", () => {});
	}

	// Private folder.
	const dir = opts.address.kind === "unix" ? dirname(opts.address.path) : dirname(opts.address.file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(dir, 0o700);
	// Listener.
	const server: Server = createServer(onClient);
	if (opts.address.kind === "unix") {
		// A socket left by a host that died is replaced.
		if (existsSync(opts.address.path)) unlinkSync(opts.address.path);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen((opts.address as { path: string }).path, () => resolve());
		});
		// Owner only.
		chmodSync(opts.address.path, 0o600);
	} else {
		// Any free loopback port.
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const port = (server.address() as { port: number }).port;
		writePrivate(opts.address.file, `${JSON.stringify({ port, token } satisfies TcpInfo)}\n`, 0o600);
	}
	log(`jiawriter browser host listening (${opts.address.kind})`);

	// Frames from Chrome until stdin ends.
	await new Promise<void>((resolve) => {
		let rest: Buffer = Buffer.alloc(0);
		opts.input.on("data", (chunk: Buffer) => {
			const got = decodeFrames(Buffer.concat([rest, chunk]));
			rest = got.rest;
			for (const m of got.messages) {
				const msg = m as Record<string, unknown>;
				// The extension introduces itself.
				if ("hello" in msg) log(`extension ${String(msg.hello)} connected`);
				// A reply to a pending request.
				const done = pending.get(Number(msg.id));
				if (done) {
					pending.delete(Number(msg.id));
					done(msg);
				}
			}
		});
		opts.input.on("end", () => resolve());
		opts.input.on("close", () => resolve());
		opts.input.on("error", () => resolve());
	});

	// Stop listening and remove the address.
	await new Promise<void>((resolve) => server.close(() => resolve()));
	try {
		if (opts.address.kind === "unix") unlinkSync(opts.address.path);
		else unlinkSync(opts.address.file);
	} catch {
		// Already gone.
	}
}

/** Entry for `jiawriter chrome-extension://…`: refuse other callers, then serve on stdio. */
export async function hostMain(args: readonly string[], agentDir: string): Promise<number> {
	// Only our extension may start the host.
	if (args[0].replace(/\/+$/, "") !== `chrome-extension://${EXTENSION_ID}`) {
		process.stderr.write(`jiawriter: refusing native messaging caller ${args[0]}\n`);
		return 2;
	}
	// Serve until Chrome goes away.
	await runHost({
		input: process.stdin,
		output: process.stdout,
		address: bridgeAddress(agentDir, process.platform),
		log: (line) => process.stderr.write(`${line}\n`),
	});
	return 0;
}

/** Send one request to the extension through the host and return its result. */
export function bridgeCall(
	address: BridgeAddress,
	op: string,
	args: Record<string, unknown> = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
	// Where to connect and the token.
	let sock: Socket;
	let token = "";
	try {
		if (address.kind === "unix") sock = createConnection(address.path);
		else {
			const info = JSON.parse(readFileSync(address.file, "utf-8")) as TcpInfo;
			token = info.token;
			sock = createConnection(info.port, "127.0.0.1");
		}
	} catch {
		// No port file: the host is not running.
		return Promise.reject(new BridgeUnavailable(NOT_CONNECTED));
	}
	// One request line, one reply line.
	return new Promise((resolve, reject) => {
		// Received bytes.
		let buf: Buffer = Buffer.alloc(0);
		// Settle once.
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			fn();
		};
		// The host's own timeout plus a margin.
		const timer = setTimeout(() => finish(() => reject(new BridgeError(`${op}: no reply`))), timeoutMs + 10_000);
		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ op, args, timeout: timeoutMs / 1000, ...(token ? { token } : {}) })}\n`);
		});
		sock.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const nl = buf.indexOf(10);
			if (nl < 0) return;
			finish(() => {
				try {
					const reply = JSON.parse(buf.subarray(0, nl).toString("utf-8")) as {
						ok?: boolean;
						result?: unknown;
						error?: string;
					};
					if (reply.ok) resolve(reply.result);
					else reject(new BridgeError(reply.error || `${op} failed`));
				} catch (e) {
					reject(new BridgeError(e instanceof Error ? e.message : String(e)));
				}
			});
		});
		// A missing socket or a dead host.
		sock.on("error", () => finish(() => reject(new BridgeUnavailable(NOT_CONNECTED))));
		sock.on("close", () => finish(() => reject(new BridgeUnavailable(NOT_CONNECTED))));
	});
}
