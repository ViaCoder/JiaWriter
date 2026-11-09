// The pinned desktop driver (src/writer/computer/driver.ts).
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assetMatches,
	assetUrl,
	DRIVER_VERSION,
	driverAsset,
	driverDir,
	driverEnv,
	driverPath,
	forgetAccountHome,
	MAC_APP,
	macAccountHome,
} from "../../src/writer/computer/driver.ts";

describe("driverAsset", () => {
	it("covers the six packages, on a stable release", () => {
		for (const [platform, arch] of [
			["linux", "x64"],
			["linux", "arm64"],
			["win32", "x64"],
			["win32", "arm64"],
			["darwin", "x64"],
			["darwin", "arm64"],
		] as const) {
			const asset = driverAsset(platform, arch);
			expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset?.file).toContain(DRIVER_VERSION);
			expect(asset?.file).not.toContain("nightly");
		}
		expect(driverAsset("freebsd", "x64")).toBeUndefined();
	});
});

describe("assetUrl", () => {
	it("points at the versioned release, not a moving one", () => {
		const url = assetUrl({ file: "a.tgz", sha256: "" });
		expect(url).toContain(`cua-driver-rs-v${DRIVER_VERSION}/a.tgz`);
		expect(url).not.toContain("latest");
	});
});

describe("assetMatches", () => {
	it("accepts the release's bytes only", () => {
		const bytes = new TextEncoder().encode("x");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		expect(assetMatches(bytes, { file: "", sha256 })).toBe(true);
		expect(assetMatches(new TextEncoder().encode("y"), { file: "", sha256 })).toBe(false);
	});
});

describe("driverDir and driverPath", () => {
	it("keeps each version apart", () => {
		expect(driverDir("/a")).toBe(join("/a", "computer", DRIVER_VERSION));
	});
	it("uses each system's place, and a named copy first", () => {
		expect(driverPath("/a", "linux", {})).toBe(join(driverDir("/a"), "cua-driver"));
		expect(driverPath("/a", "win32", {})).toBe(join(driverDir("/a"), "cua-driver.exe"));
		expect(driverPath("/a", "darwin", {}).startsWith(MAC_APP)).toBe(true);
		expect(driverPath("/a", "linux", { JW_COMPUTER_DRIVER: "/b" })).toBe("/b");
	});
});

describe("driverEnv", () => {
	it("turns telemetry off, and keeps secrets and everything else out", () => {
		const env = driverEnv({ PATH: "/p", DISPLAY: ":1", JW_KEY: "sk-secret", ANYTHING: "x", CUA_TELEMETRY: "1" });
		expect(env).toMatchObject({
			PATH: "/p",
			DISPLAY: ":1",
			CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
			CUA_TELEMETRY_ENABLED: "0",
			CUA_TELEMETRY: "0",
			CUA_DRIVER_PERMISSION_MODE: "standard",
		});
		expect(env.JW_KEY).toBeUndefined();
		expect(env.ANYTHING).toBeUndefined();
	});
	it("falls back on the runtime's answer when the directory service cannot be asked", () => {
		expect(
			macAccountHome(() => {
				throw new Error("no dscl");
			}),
		).toBe(userInfo().homedir);
	});
	it("finds the account's home through the directory service, whatever HOME says", () => {
		// On a Mac the tests above found the real home already (CI 42539031250, 2026-11-09).
		forgetAccountHome();
		const asked: string[] = [];
		const read = (command: string, args: string[]) => {
			asked.push([command, ...args].join(" "));
			return command.endsWith("id") ? "runner\n" : "NFSHomeDirectory: /Users/runner\n";
		};
		expect(macAccountHome(read)).toBe("/Users/runner");
		expect(asked).toEqual(["/usr/bin/id -un", "/usr/bin/dscl . -read /Users/runner NFSHomeDirectory"]);
		// Found once, kept.
		expect(macAccountHome(() => "")).toBe("/Users/runner");
	});
	it("uses the account's own home on macOS, where the system starts the daemon", () => {
		expect(driverEnv({ HOME: "/tmp/x" }, "darwin", () => "/Users/u").HOME).toBe("/Users/u");
		expect(driverEnv({ HOME: "/tmp/x" }, "linux", () => "/Users/u").HOME).toBe("/tmp/x");
	});
});
