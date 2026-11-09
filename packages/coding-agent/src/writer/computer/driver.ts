/**
 * The desktop driver: cua-driver, a stable release pinned here, kept out of the package and installed on request.
 * Each system uses its own best route behind the same protocol: UI Automation on Windows, Accessibility on macOS,
 * AT-SPI and the compositor on Linux. Everything that decides what the driver may do lives in tool.ts.
 */

// Checking and paths.
// The account's home on macOS, from the directory service.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";

/** The pinned version; it changes with a JiaWriter release, never by itself. */
export const DRIVER_VERSION = "0.41.2";
/** Where the releases are. */
const RELEASES = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${DRIVER_VERSION}`;
/** The macOS app: permissions belong to its signed identity, so it lives where the system expects it. */
export const MAC_APP = "/Applications/CuaDriver.app";

/** One platform's download. */
export interface DriverAsset {
	file: string;
	sha256: string;
}

/** Downloads, by system and processor, with the checksums of the release. */
const ASSETS: Readonly<Record<string, DriverAsset>> = {
	"linux-x64": {
		file: "cua-driver-rs-0.41.2-linux-x86_64-binary.tar.gz",
		sha256: "aab4bc0978822102bf8276350aa2c101d3f7eb519adbc17fa949b5ea1bac892d",
	},
	"linux-arm64": {
		file: "cua-driver-rs-0.41.2-linux-arm64-binary.tar.gz",
		sha256: "4f2358c6b101844a4dc9556545cd0480e701d30dff90bd2b3f28045b8d6b392b",
	},
	"win32-x64": {
		file: "cua-driver-rs-0.41.2-windows-x86_64-binary.zip",
		sha256: "1084e1f0e74ce3d281a7010c7d765c3039c05dbc503fc0470f4b95751b58c391",
	},
	"win32-arm64": {
		file: "cua-driver-rs-0.41.2-windows-arm64-binary.zip",
		sha256: "95c0a279997ef4a2ac581d951ff135c79432e2681c5c24aa1492938902cdad2f",
	},
	"darwin-arm64": {
		file: "cua-driver-rs-0.41.2-darwin-universal.tar.gz",
		sha256: "fccd0390a942d1c4b8d7a48d2b35acb512ee23943a99fcf5b5151ee234e44f7a",
	},
	"darwin-x64": {
		file: "cua-driver-rs-0.41.2-darwin-universal.tar.gz",
		sha256: "fccd0390a942d1c4b8d7a48d2b35acb512ee23943a99fcf5b5151ee234e44f7a",
	},
};

/** The download for this machine, or undefined where there is none. */
export function driverAsset(platform: NodeJS.Platform, arch: string): DriverAsset | undefined {
	return ASSETS[`${platform}-${arch}`];
}

/** The address of a download. */
export function assetUrl(asset: DriverAsset): string {
	return `${RELEASES}/${asset.file}`;
}

/** True when the bytes are the release's. */
export function assetMatches(bytes: Uint8Array, asset: DriverAsset): boolean {
	return createHash("sha256").update(bytes).digest("hex") === asset.sha256;
}

/** The folder of the pinned version. */
export function driverDir(agentDir: string): string {
	return join(agentDir, "computer", DRIVER_VERSION);
}

/** The driver program; JW_COMPUTER_DRIVER names another copy. */
export function driverPath(agentDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
	if (env.JW_COMPUTER_DRIVER) return env.JW_COMPUTER_DRIVER;
	// A macOS path, written with / whatever system builds it (tests run on Windows too).
	if (platform === "darwin") return `${MAC_APP}/Contents/MacOS/cua-driver`;
	return join(driverDir(agentDir), platform === "win32" ? "cua-driver.exe" : "cua-driver");
}

/** How a command's output is read: execFileSync, or a stand-in in tests. */
export type ReadCommand = (command: string, args: string[]) => string;

/** The account home once found, for the life of the program. */
let knownHome: string | undefined;

/** Forget the account home found so far (tests: on a real Mac an earlier call has found it already). */
export function forgetAccountHome(): void {
	knownHome = undefined;
}

/**
 * The home the system records for this account on macOS. Bun's os.userInfo().homedir gives $HOME instead
 * (checked with bun 1.4.4), so the directory service is asked; failing that, what the runtime says.
 */
export function macAccountHome(
	read: ReadCommand = (command, args) => execFileSync(command, args, { encoding: "utf-8", timeout: 5000 }),
): string {
	if (knownHome) return knownHome;
	try {
		const name = read("/usr/bin/id", ["-un"]).trim();
		const entry = read("/usr/bin/dscl", [".", "-read", `/Users/${name}`, "NFSHomeDirectory"]);
		const home = /NFSHomeDirectory:\s*(\S.*)$/m.exec(entry)?.[1]?.trim();
		if (home) {
			knownHome = home;
			return home;
		}
	} catch {
		// No directory service: the runtime's answer below.
	}
	return userInfo().homedir;
}

/**
 * What the driver may see of the environment: no keys, and its telemetry off. On macOS the system starts the
 * daemon with the account's own home, and the socket and settings live there, so every driver command uses it too.
 */
export function driverEnv(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	accountHome: () => string = () => macAccountHome(),
): NodeJS.ProcessEnv {
	const kept = [
		"PATH",
		"HOME",
		"USER",
		"LANG",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XAUTHORITY",
		"DBUS_SESSION_BUS_ADDRESS",
		"XDG_RUNTIME_DIR",
		"XDG_SESSION_TYPE",
		"XDG_CURRENT_DESKTOP",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"SystemRoot",
		"TEMP",
		"TMP",
	];
	const out: NodeJS.ProcessEnv = {};
	for (const name of kept) if (env[name] !== undefined) out[name] = env[name];
	// The home the system gives the daemon, not one a caller set.
	if (platform === "darwin") out.HOME = accountHome();
	return {
		...out,
		CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
		CUA_TELEMETRY_ENABLED: "0",
		CUA_TELEMETRY: "0",
		CUA_DRIVER_PERMISSION_MODE: "standard",
	};
}
