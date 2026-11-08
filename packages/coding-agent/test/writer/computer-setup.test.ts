// Setting up desktop control (src/writer/computer/setup.ts): every step, with the machine replaced, and no model.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { driverAsset, driverPath, MAC_APP } from "../../src/writer/computer/driver.ts";
import {
	installDriver,
	linuxSteps,
	macPaneUrl,
	macSteps,
	onGnome,
	parseDoctor,
	runSetup,
	type SetupDeps,
	stopTelemetry,
	tarCommand,
} from "../../src/writer/computer/setup.ts";

/** A machine that answers commands from a table. */
function machine(more: Partial<SetupDeps> = {}, answers: Record<string, { code: number; stdout?: string }> = {}) {
	const ran: string[] = [];
	const notes: [string, string][] = [];
	const written: string[] = [];
	const asked: string[] = [];
	const deps: SetupDeps = {
		platform: "linux",
		arch: "x64",
		agentDir: "/a",
		env: {},
		exists: () => false,
		fetchBytes: async () => new Uint8Array(),
		writeFile: (path) => void written.push(path),
		makeDir: () => undefined,
		run: async (command, args) => {
			const line = `${command} ${args.join(" ")}`;
			ran.push(line);
			const hit = Object.entries(answers).find(([k]) => line.includes(k))?.[1];
			return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "" };
		},
		notify: (text, kind) => void notes.push([text, kind]),
		confirm: async (title) => {
			asked.push(title);
			return true;
		},
		...more,
	};
	return { deps, ran, notes, written, asked };
}

describe("parseDoctor", () => {
	it("reads each line's level", () => {
		const lines = parseDoctor("[ok  ] binary: x\n         git: y\n[warn] AT-SPI: no bus\n[fail] z\n");
		expect(lines).toEqual([
			{ level: "ok", text: "binary: x" },
			{ level: "warn", text: "AT-SPI: no bus" },
			{ level: "fail", text: "z" },
		]);
	});
});

describe("macPaneUrl", () => {
	it("opens the exact settings page", () => {
		expect(macPaneUrl("Privacy_Accessibility")).toBe(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
		);
	});
});

describe("onGnome", () => {
	it("reads the desktop's name", () => {
		expect(onGnome({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
		expect(onGnome({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
		expect(onGnome({})).toBe(false);
	});
});

describe("installDriver", () => {
	/** Bytes that pass the check, by making the fake asset's sum theirs. */
	const good = new TextEncoder().encode("release");

	it("never unpacks a file that fails its checksum", async () => {
		const { deps, ran, written, notes } = machine({ fetchBytes: async () => good });
		expect(await installDriver(deps)).toBe(false);
		expect(ran.length).toBe(0);
		expect(written.length).toBe(0);
		expect(notes.at(-1)?.[1]).toBe("error");
	});

	it("stops on a machine with no release", async () => {
		const { deps, notes } = machine({ platform: "freebsd" });
		expect(await installDriver(deps)).toBe(false);
		expect(notes.at(-1)?.[1]).toBe("error");
	});

	it("names the real sum of each file", () => {
		expect(driverAsset("linux", "x64")?.sha256).not.toBe(createHash("sha256").update(good).digest("hex"));
	});
});

describe("macSteps", () => {
	it("lets the driver ask, in its own name", async () => {
		const { deps, ran } = machine({ platform: "darwin" });
		expect(await macSteps(deps, "/d")).toBe(true);
		expect(ran).toEqual(["/d permissions grant"]);
	});
	it("opens both settings pages when that did not finish", async () => {
		const { deps, ran, notes } = machine({ platform: "darwin" }, { "permissions grant": { code: 1 } });
		expect(await macSteps(deps, "/d")).toBe(false);
		expect(ran.filter((r) => r.startsWith("open "))).toHaveLength(2);
		expect(notes.at(-1)?.[1]).toBe("warning");
	});
});

describe("linuxSteps", () => {
	it("has nothing to do outside GNOME", async () => {
		const { deps, ran } = machine({ env: { XDG_CURRENT_DESKTOP: "KDE" } });
		expect(await linuxSteps(deps)).toBe(true);
		expect(ran.length).toBe(0);
	});
	it("turns accessibility on only when the user agrees, then asks for a new login", async () => {
		const yes = machine(
			{ env: { XDG_CURRENT_DESKTOP: "GNOME" } },
			{ "get org.gnome": { code: 0, stdout: "false\n" } },
		);
		expect(await linuxSteps(yes.deps)).toBe(false);
		expect(yes.ran.some((r) => r.includes("set org.gnome"))).toBe(true);
		const no = machine(
			{ env: { XDG_CURRENT_DESKTOP: "GNOME" }, confirm: async () => false },
			{ "get org.gnome": { code: 0, stdout: "false\n" } },
		);
		expect(await linuxSteps(no.deps)).toBe(true);
		expect(no.ran.some((r) => r.includes("set org.gnome"))).toBe(false);
	});
	it("installs the window helper on GNOME under Wayland", async () => {
		const { deps, ran } = machine(
			{ env: { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "wayland" }, exists: () => true },
			{ "get org.gnome": { code: 0, stdout: "true\n" } },
		);
		await linuxSteps(deps);
		expect(ran.some((r) => r.includes(join("wayland-helper", "install.sh")))).toBe(true);
	});
});

describe("runSetup", () => {
	const installed = { exists: () => true };

	it("is ready when the driver's doctor is clean", async () => {
		const { deps } = machine(installed, { doctor: { code: 0, stdout: "[ok  ] a\n" } });
		expect(await runSetup(deps)).toBe("ready");
	});
	it("says what limits it", async () => {
		const { deps, notes } = machine(installed, { doctor: { code: 0, stdout: "[warn] AT-SPI: no bus\n" } });
		expect(await runSetup(deps)).toBe("limited");
		expect(notes.at(-1)?.[0]).toContain("AT-SPI");
	});
	it("stops when the driver cannot be installed", async () => {
		const { deps } = machine({ fetchBytes: async () => new Uint8Array([1]) });
		expect(await runSetup(deps)).toBe("stopped");
	});
	it("uses the app's own program on macOS", async () => {
		const { deps, ran } = machine(
			{ platform: "darwin", ...installed },
			{ doctor: { code: 0, stdout: "[ok  ] a\n" } },
		);
		await runSetup(deps);
		expect(ran[0].startsWith(driverPath("/a", "darwin", {}))).toBe(true);
		expect(ran[0]).toContain(MAC_APP);
	});
});

describe("stopTelemetry", () => {
	it("turns it off in the driver's own settings", async () => {
		const { deps, ran } = machine();
		await stopTelemetry(deps, "/d");
		expect(ran).toEqual(["/d telemetry disable"]);
	});
	it("is part of every setup, and of an install alone, which stops there", async () => {
		const { deps, ran } = machine({ exists: () => true, platform: "darwin" });
		expect(await runSetup(deps, true)).toBe("limited");
		expect(ran.length).toBe(1);
		expect(ran[0]).toContain("telemetry disable");
	});
});

describe("tarCommand", () => {
	it("uses the system's own on Windows, where another tar on the PATH cannot read a zip", () => {
		expect(tarCommand("win32", { SystemRoot: "C:\\Windows" })).toContain("System32");
		expect(tarCommand("win32", {})).toContain("System32");
		expect(tarCommand("linux", {})).toBe("tar");
		expect(tarCommand("darwin", {})).toBe("tar");
	});
});
