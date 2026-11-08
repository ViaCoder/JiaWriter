/**
 * Setting up desktop control, step by step, by the program alone: nothing here reaches a model. Each step checks,
 * explains, does what it can, and checks again. The driver's own `doctor` and `permissions grant` do the judging.
 */

// Paths.
import { join } from "node:path";
// Messages.
import { t } from "../i18n/index.ts";
// What to fetch and where it goes.
import { assetMatches, assetUrl, DRIVER_VERSION, driverAsset, driverDir, driverPath, MAC_APP } from "./driver.ts";

/** A command's outcome. */
export interface RunResult {
	code: number;
	stdout: string;
}

/** What setting up needs from outside. */
export interface SetupDeps {
	platform: NodeJS.Platform;
	arch: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	exists(path: string): boolean;
	fetchBytes(url: string): Promise<Uint8Array>;
	writeFile(path: string, bytes: Uint8Array): void;
	makeDir(path: string): void;
	run(command: string, args: string[]): Promise<RunResult>;
	notify(text: string, kind: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
}

/** One line of the driver's doctor. */
export interface DoctorLine {
	level: "ok" | "warn" | "fail";
	text: string;
}

/** Where it ended. */
export type SetupEnd = "ready" | "limited" | "stopped";

/** The settings pages of the two macOS permissions. */
const MAC_PANES = ["Privacy_Accessibility", "Privacy_ScreenCapture"];

/** The lines of the driver's doctor. */
export function parseDoctor(output: string): DoctorLine[] {
	return [...output.matchAll(/^\[(ok|warn|fail)\s*\]\s*(.+)$/gm)].map((m) => ({
		level: m[1] as DoctorLine["level"],
		text: m[2].trim(),
	}));
}

/** The URL that opens a macOS settings page. */
export function macPaneUrl(pane: string): string {
	return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}

/** True on GNOME. */
export function onGnome(env: NodeJS.ProcessEnv): boolean {
	return /gnome/i.test(env.XDG_CURRENT_DESKTOP ?? "");
}

/** The unpacker: Windows' own reads zip files, and another tar may come first on the PATH there. */
export function tarCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	return platform === "win32" ? `${env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "tar";
}

/** Fetch, check and unpack the pinned driver; false when it stopped. */
export async function installDriver(deps: SetupDeps): Promise<boolean> {
	const asset = driverAsset(deps.platform, deps.arch);
	if (!asset) {
		deps.notify(t("setup.none"), "error");
		return false;
	}
	deps.notify(t("setup.download", { version: DRIVER_VERSION, mb: deps.platform === "darwin" ? 86 : 38 }), "info");
	const bytes = await deps.fetchBytes(assetUrl(asset));
	// A file that is not the release is never unpacked.
	if (!assetMatches(bytes, asset)) {
		deps.notify(t("setup.badSum"), "error");
		return false;
	}
	const dir = driverDir(deps.agentDir);
	deps.makeDir(dir);
	const archive = join(dir, asset.file);
	deps.writeFile(archive, bytes);
	const unpacked = await deps.run(tarCommand(deps.platform, deps.env), ["-xf", archive, "-C", dir]);
	if (unpacked.code !== 0) return false;
	// The app carries the signature its permissions belong to, so it is copied whole.
	if (deps.platform === "darwin") {
		const found = await deps.run("find", [dir, "-maxdepth", "3", "-name", "CuaDriver.app"]);
		const copied = await deps.run("ditto", [found.stdout.trim().split("\n")[0], MAC_APP]);
		if (copied.code !== 0) {
			deps.notify(t("setup.macApp"), "warning");
			return false;
		}
	}
	deps.notify(t("setup.installed"), "info");
	return true;
}

/** The two macOS permissions, through the driver, which names itself in the dialogs and verifies the result. */
export async function macSteps(deps: SetupDeps, driver: string): Promise<boolean> {
	deps.notify(t("setup.macStart"), "info");
	const granted = await deps.run(driver, ["permissions", "grant"]);
	if (granted.code === 0) return true;
	for (const pane of MAC_PANES) await deps.run("open", [macPaneUrl(pane)]);
	deps.notify(t("setup.macOpen"), "warning");
	return false;
}

/** Linux: the desktop's accessibility, and the window helper on GNOME under Wayland. */
export async function linuxSteps(deps: SetupDeps): Promise<boolean> {
	if (!onGnome(deps.env)) return true;
	let again = false;
	const state = await deps.run("gsettings", ["get", "org.gnome.desktop.interface", "toolkit-accessibility"]);
	if (state.stdout.trim() === "false" && (await deps.confirm(t("setup.confirmTitle"), t("setup.a11yAsk")))) {
		await deps.run("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"]);
		again = true;
	}
	const helper = join(driverDir(deps.agentDir), "wayland-helper", "install.sh");
	if (
		deps.env.XDG_SESSION_TYPE === "wayland" &&
		deps.exists(helper) &&
		(await deps.confirm(t("setup.confirmTitle"), t("setup.waylandAsk")))
	) {
		await deps.run("sh", [helper]);
		again = true;
	}
	if (again) deps.notify(t("setup.relogin"), "info");
	return !again;
}

/** Turn the driver's telemetry off for good: on macOS the system starts it, so it never sees our environment. */
export async function stopTelemetry(deps: SetupDeps, driver: string): Promise<void> {
	await deps.run(driver, ["telemetry", "disable"]);
}

/** The whole setup; `installOnly` stops once the driver is in place, ahead of the system's own steps. */
export async function runSetup(deps: SetupDeps, installOnly = false): Promise<SetupEnd> {
	const driver = driverPath(deps.agentDir, deps.platform, deps.env);
	if (!deps.exists(driver) && !(await installDriver(deps))) return "stopped";
	await stopTelemetry(deps, driver);
	if (installOnly) return "limited";
	const system =
		deps.platform === "darwin"
			? await macSteps(deps, driver)
			: deps.platform === "linux"
				? await linuxSteps(deps)
				: true;
	if (!system) return "stopped";
	const doctor = parseDoctor((await deps.run(driver, ["doctor"])).stdout);
	const problems = doctor.filter((line) => line.level !== "ok").map((line) => line.text);
	if (problems.length === 0) {
		deps.notify(t("setup.ok"), "info");
		return "ready";
	}
	deps.notify(t("setup.limited", { problems: problems.join("；") }), "warning");
	return "limited";
}
