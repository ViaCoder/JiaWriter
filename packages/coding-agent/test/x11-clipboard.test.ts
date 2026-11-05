// The X11 clipboard owner: its message parts on their own, then against a real X server (Xvfb, so the desktop's
// clipboard is not touched), read back by the native helper, a separate X client.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeX11Clipboard,
	copyViaX11,
	displayNumber,
	findCookie,
	parseSetup,
	setupRequest,
} from "../src/utils/x11-clipboard.ts";

/** One record of an X authority file. */
function authRecord(family: number, display: string, name: string, data: Buffer): Buffer {
	const field = (value: Buffer) => {
		const length = Buffer.alloc(2);
		length.writeUInt16BE(value.length);
		return Buffer.concat([length, value]);
	};
	const head = Buffer.alloc(2);
	head.writeUInt16BE(family);
	return Buffer.concat([
		head,
		field(Buffer.from("host")),
		field(Buffer.from(display)),
		field(Buffer.from(name)),
		field(data),
	]);
}

describe("displayNumber", () => {
	it("reads local displays and leaves remote ones", () => {
		expect(displayNumber(":0")).toBe(0);
		expect(displayNumber(":12.0")).toBe(12);
		expect(displayNumber("unix:3")).toBe(3);
		expect(displayNumber("host:0")).toBeUndefined();
		expect(displayNumber(undefined)).toBeUndefined();
	});
});

describe("findCookie", () => {
	const cookie = Buffer.from("0123456789abcdef");
	it("takes the entry of the display, or one for all displays", () => {
		const other = authRecord(256, "1", "MIT-MAGIC-COOKIE-1", Buffer.from("other"));
		const file = Buffer.concat([other, authRecord(256, "0", "MIT-MAGIC-COOKIE-1", cookie)]);
		expect(findCookie(file, 0)).toEqual(cookie);
		expect(findCookie(authRecord(65535, "", "MIT-MAGIC-COOKIE-1", cookie), 7)).toEqual(cookie);
	});

	it("leaves other methods and network entries", () => {
		expect(findCookie(authRecord(256, "0", "XDM-AUTHORIZATION-1", cookie), 0)).toBeUndefined();
		expect(findCookie(authRecord(0, "0", "MIT-MAGIC-COOKIE-1", cookie), 0)).toBeUndefined();
	});
});

describe("setupRequest", () => {
	it("pads every part to four bytes", () => {
		expect(setupRequest(undefined)).toHaveLength(12);
		// 12 of head, 18 of name padded to 20, 16 of cookie.
		const message = setupRequest(Buffer.alloc(16));
		expect(message).toHaveLength(48);
		expect(message.readUInt16LE(6)).toBe(18);
		expect(message.readUInt16LE(8)).toBe(16);
	});
});

describe("parseSetup", () => {
	it("finds the root window behind the vendor name and formats, and refuses a failed setup", () => {
		const reply = Buffer.alloc(64);
		reply[0] = 1;
		reply.writeUInt32LE(0x400000, 12);
		reply.writeUInt16LE(5, 24);
		reply.writeUInt16LE(65535, 26);
		reply[29] = 1;
		// 40 of fixed part, 5 of vendor padded to 8, 8 of format.
		reply.writeUInt32LE(0x123, 56);
		expect(parseSetup(reply)).toEqual({ idBase: 0x400000, root: 0x123, maxBytes: 65535 * 4 - 24 });
		reply[0] = 0;
		expect(parseSetup(reply)).toBeUndefined();
	});
});

const XVFB = ["/usr/bin/Xvfb"].find((p) => existsSync(p));
// The reader: a prebuilt helper that not every architecture has.
const READER = new URL(
	`../../tui/native/linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`,
	import.meta.url,
);

describe.skipIf(!XVFB || process.platform !== "linux" || !existsSync(READER))("against a real X server", () => {
	const display = 73;
	const dir = mkdtempSync(join(tmpdir(), "jw-x11-"));
	const authority = join(dir, "authority");
	let server: ChildProcess;

	beforeAll(async () => {
		// A server that takes only the test's own cookie.
		const cookie = Buffer.from("a test cookie 16");
		writeFileSync(authority, authRecord(65535, "", "MIT-MAGIC-COOKIE-1", cookie));
		server = spawn(XVFB ?? "", [`:${display}`, "-auth", authority, "-nolisten", "tcp"], { stdio: "ignore" });
		for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display}`); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
	});

	// In every test: the configuration resets stubbed variables, and a real DISPLAY would reach the desktop's clipboard.
	beforeEach(() => {
		vi.stubEnv("DISPLAY", `:${display}`);
		vi.stubEnv("XAUTHORITY", authority);
		expect(process.env.DISPLAY).toBe(`:${display}`);
	});

	afterAll(() => {
		closeX11Clipboard();
		server.kill();
		rmSync(dir, { recursive: true, force: true });
	});

	it("hands Chinese text to a program that pastes, and takes a new text after it", async () => {
		expect(await copyViaX11("选中的文字，含 English 和 123")).toBe(true);
		expect(await getNativeClipboard()?.getText()).toBe("选中的文字，含 English 和 123");
		expect(await copyViaX11("第二次复制")).toBe(true);
		expect(await getNativeClipboard()?.getText()).toBe("第二次复制");
	});

	it("carries a long passage", async () => {
		const text = "一段很长的正文。".repeat(10_000);
		expect(await copyViaX11(text)).toBe(true);
		expect(await getNativeClipboard()?.getText()).toBe(text);
	});

	it("says no when the text does not fit one request", async () => {
		expect(await copyViaX11("长".repeat(200_000))).toBe(false);
	});

	it("says no when the cookie is wrong", async () => {
		closeX11Clipboard();
		const wrong = join(dir, "wrong");
		writeFileSync(wrong, authRecord(65535, "", "MIT-MAGIC-COOKIE-1", Buffer.from("not the cookie!!")));
		expect(await copyViaX11("x", { DISPLAY: `:${display}`, XAUTHORITY: wrong })).toBe(false);
		closeX11Clipboard();
	});

	it("says no when there is no server", async () => {
		closeX11Clipboard();
		expect(await copyViaX11("x", { DISPLAY: ":74", XAUTHORITY: authority })).toBe(false);
		closeX11Clipboard();
	});
});
