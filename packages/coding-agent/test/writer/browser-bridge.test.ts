// Unit and functional tests for src/writer/browser/bridge.ts: frames, ids, addresses, tokens, and a
// host round trip over a Unix socket and over the token-guarded loopback port. No Chrome.

// Temp folders and the manifest key.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
// Raw client for the wrong-token case.
import { createConnection } from "node:net";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join, resolve } from "node:path";
// Fake stdin/stdout of the host.
import { PassThrough } from "node:stream";
// Test API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Module under test.
import {
	type BridgeAddress,
	BridgeError,
	BridgeUnavailable,
	bridgeAddress,
	bridgeCall,
	decodeFrames,
	EXTENSION_ID,
	encodeFrame,
	extensionIdFromKey,
	hostMain,
	isHostArgv,
	runHost,
	tokenMatches,
} from "../../src/writer/browser/bridge.ts";

// The extension's manifest in the repository.
const MANIFEST = resolve(__dirname, "../../../../search_fetch/src/search_fetch/extension/manifest.json");

// Scratch folder (short: Unix socket paths are length-limited).
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wab-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("extensionIdFromKey / EXTENSION_ID", () => {
	it("derives the id Chrome gives the extension from its manifest key", () => {
		const key = (JSON.parse(readFileSync(MANIFEST, "utf-8")) as { key: string }).key;
		expect(extensionIdFromKey(key)).toBe(EXTENSION_ID);
		expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
	});
});

describe("isHostArgv", () => {
	it("recognises Chrome's extension origin as the first argument only", () => {
		expect(isHostArgv([`chrome-extension://${EXTENSION_ID}/`])).toBe(true);
		expect(isHostArgv([`chrome-extension://${EXTENSION_ID}/`, "--parent-window=0"])).toBe(true);
		expect(isHostArgv([])).toBe(false);
		expect(isHostArgv(["-p", "chrome-extension://x/"])).toBe(false);
	});
});

describe("bridgeAddress", () => {
	it("uses a socket on Unix and a port file on Windows, both in <agentDir>/browser", () => {
		expect(bridgeAddress("/a", "linux")).toEqual({ kind: "unix", path: join("/a", "browser", "bridge.sock") });
		expect(bridgeAddress("/a", "darwin").kind).toBe("unix");
		expect(bridgeAddress("/a", "win32")).toEqual({ kind: "tcp", file: join("/a", "browser", "bridge.json") });
	});
});

describe("encodeFrame / decodeFrames", () => {
	it("round-trips messages, keeps a partial frame and skips malformed JSON", () => {
		const a = encodeFrame({ id: 1, ok: true, result: "中文" });
		expect(a.readUInt32LE(0)).toBe(a.length - 4);
		const bad = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{x}")]);
		const b = encodeFrame({ hello: "2.0.0" });
		const all = Buffer.concat([a, bad, b]);
		// Whole buffer: two messages, nothing left.
		const got = decodeFrames(all);
		expect(got.messages).toEqual([{ id: 1, ok: true, result: "中文" }, { hello: "2.0.0" }]);
		expect(got.rest.length).toBe(0);
		// Cut inside the last frame: it stays in rest.
		const cut = decodeFrames(all.subarray(0, all.length - 2));
		expect(cut.messages).toHaveLength(1);
		expect(cut.rest.length).toBe(b.length - 2);
	});
});

describe("tokenMatches", () => {
	it("accepts only the same string", () => {
		expect(tokenMatches("abc", "abc")).toBe(true);
		expect(tokenMatches("abd", "abc")).toBe(false);
		expect(tokenMatches("ab", "abc")).toBe(false);
		expect(tokenMatches(undefined, "abc")).toBe(false);
	});
});

/** A host on fake stdio with a fake extension that echoes op and args back. */
async function startHost(address: BridgeAddress) {
	// Chrome → host and host → Chrome.
	const toHost = new PassThrough();
	const fromHost = new PassThrough();
	// The fake extension: reply to every frame.
	let rest: Buffer = Buffer.alloc(0);
	fromHost.on("data", (chunk: Buffer) => {
		const got = decodeFrames(Buffer.concat([rest, chunk]));
		rest = got.rest;
		for (const m of got.messages) {
			const msg = m as { id: number; op: string };
			const reply =
				msg.op === "fail" ? { id: msg.id, ok: false, error: "no such tab" } : { id: msg.id, ok: true, result: msg };
			if (msg.op !== "silent") toHost.write(encodeFrame(reply));
		}
	});
	// Run until stdin ends.
	const done = runHost({ input: toHost, output: fromHost, address });
	// Hello from the extension.
	toHost.write(encodeFrame({ hello: "2.0.0" }));
	// Wait for the listener.
	for (let i = 0; i < 50; i++) {
		if (address.kind === "unix" ? existsSync(address.path) : existsSync(address.file)) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	return {
		stop: async () => {
			toHost.end();
			await done;
		},
	};
}

describe("runHost / bridgeCall", () => {
	it("routes requests and replies over a Unix socket and removes the socket at the end", async () => {
		if (process.platform === "win32") return;
		const address = bridgeAddress(dir, "linux");
		const host = await startHost(address);
		// A request reaches the extension with its args.
		const r = (await bridgeCall(address, "open", { url: "https://example.com/" }, 2000)) as Record<string, unknown>;
		expect(r).toMatchObject({ op: "open", url: "https://example.com/" });
		// An error reply.
		await expect(bridgeCall(address, "fail", {}, 2000)).rejects.toBeInstanceOf(BridgeError);
		// No reply in time.
		await expect(bridgeCall(address, "silent", {}, 200)).rejects.toThrow(/timed out/);
		await host.stop();
		expect(existsSync((address as { path: string }).path)).toBe(false);
		// Without a host.
		await expect(bridgeCall(address, "status", {}, 500)).rejects.toBeInstanceOf(BridgeUnavailable);
	});

	it("serves loopback TCP with a token file, and refuses a wrong token", async () => {
		const address: BridgeAddress = { kind: "tcp", file: join(dir, "browser", "bridge.json") };
		const host = await startHost(address);
		const info = JSON.parse(readFileSync(address.file, "utf-8")) as { port: number; token: string };
		expect(info.token).toMatch(/^[0-9a-f]{64}$/);
		// The client reads the token itself.
		expect(await bridgeCall(address, "status", {}, 2000)).toMatchObject({ op: "status" });
		// A client with a wrong token.
		const reply = await new Promise<string>((res) => {
			const s = createConnection(info.port, "127.0.0.1", () =>
				s.write(`${JSON.stringify({ op: "status", token: "0" })}\n`),
			);
			let out = "";
			s.on("data", (c) => {
				out += c.toString();
			});
			s.on("close", () => res(out));
		});
		expect(JSON.parse(reply)).toEqual({ ok: false, error: "bad token" });
		await host.stop();
		expect(existsSync(address.file)).toBe(false);
		await expect(bridgeCall(address, "status", {}, 500)).rejects.toBeInstanceOf(BridgeUnavailable);
	});
});

describe("hostMain", () => {
	it("refuses a caller that is not the WriterAgent extension", async () => {
		expect(await hostMain(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], dir)).toBe(2);
	});
});
