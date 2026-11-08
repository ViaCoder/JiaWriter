/**
 * Built-in JiaWriter extension: the `computer` tool for desktop applications, its setup, and the overall check. The
 * tool is there only when the driver is installed, settled once per conversation so the tool set never changes.
 */

// Running helpers.
import { execFile } from "node:child_process";
// Files of the setup.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
// Upstream enum helper.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
// Parameter schemas.
import { Type } from "typebox";
// Where things live.
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
// The extension's bridge.
import { bridgeAddress, bridgeCall, bridgePresent, EXTENSION_VERSION } from "../../writer/browser/bridge.ts";
// The driver.
import { type DriverClient, startDriver } from "../../writer/computer/client.ts";
import { DRIVER_VERSION, driverEnv, driverPath } from "../../writer/computer/driver.ts";
import { type RunResult, runSetup, type SetupEnd } from "../../writer/computer/setup.ts";
import { COMPUTER_ACTIONS, type ComputerInput, newComputerState, runComputer } from "../../writer/computer/tool.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
// Text recognition.
import { ocrCommand, ocrHelperDir, onPath } from "../../writer/ocr.ts";
// Questions to the user.
import { createPermissionGate, permissionMode } from "../../writer/permission.ts";
// The shape of every result.
import { createBreaker } from "../../writer/protocol.ts";
// What is known of the upstream.
import { readSupport } from "../../writer/vision.ts";
import { provenId } from "../../writer/websearch/main-search.ts";
// The configured model.
import { getWriterModel } from "../../writer/writer-model.ts";
// A conversation's choice, and results as the model reads them.
import { knownChoice, resultContent } from "../writer-browser/index.ts";
// Looking at a window.
import { sessionVision, supportFile } from "../writer-vision/index.ts";

/** Session entry saying whether a conversation has the tool. */
const TOOL_ENTRY = "jiawriter-computer-tool";
/** What the program tells the user by itself. */
const NOT_INSTALLED = "not-installed";
/** Longest a setup command may take (ms): a permission dialog waits for a person. */
const SETUP_MS = 5 * 60_000;

/** Run a command and collect its output. */
export function runCommand(command: string, args: string[]): Promise<RunResult> {
	return new Promise((done) => {
		execFile(command, args, { timeout: SETUP_MS, env: driverEnv(process.env) }, (error, stdout) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			done({ code, stdout: String(stdout) });
		});
	});
}

/** /jw computer. */
export async function computerSetup(ctx: ExtensionCommandContext, installOnly = false): Promise<SetupEnd> {
	return runSetup(
		{
			platform: process.platform,
			arch: process.arch,
			agentDir: getAgentDir(),
			env: process.env,
			exists: existsSync,
			fetchBytes: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
			writeFile: (path, bytes) => writeFileSync(path, bytes),
			makeDir: (path) => void mkdirSync(path, { recursive: true }),
			run: runCommand,
			notify: (text, kind) => ctx.ui.notify(text, kind),
			confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
		},
		installOnly,
	);
}

/** The facts /jw doctor shows. */
export interface DoctorFacts {
	model?: string;
	images?: boolean;
	// The extension's version, or undefined when it does not answer.
	extension?: string;
	ocr: boolean;
	driver: boolean;
	mode: string;
}

/** Each fact as a line with what to do about it. */
export function factLines(facts: DoctorFacts): string[] {
	const extension =
		facts.extension === undefined
			? t("doctor.extNo")
			: facts.extension === EXTENSION_VERSION
				? t("doctor.extOk", { version: facts.extension })
				: t("doctor.extOld", { version: facts.extension });
	return [
		t("doctor.title"),
		facts.model ? t("doctor.upstreamOk", { model: facts.model }) : t("doctor.upstreamNo"),
		facts.images === undefined ? t("doctor.imageUnknown") : facts.images ? t("doctor.imageYes") : t("doctor.imageNo"),
		extension,
		facts.ocr ? t("doctor.ocrYes") : t("doctor.ocrNo"),
		facts.driver ? t("doctor.computerOk", { version: DRIVER_VERSION }) : t("doctor.computerNo"),
		t("doctor.mode", { mode: facts.mode }),
	];
}

/** /jw doctor. */
export async function doctorLines(): Promise<string[]> {
	const state = getWriterModel();
	const ready = state.kind === "ready" ? state : undefined;
	const address = bridgeAddress(getAgentDir(), process.platform);
	const status = bridgePresent(address)
		? await bridgeCall(address, "status", {}, 1500).catch(() => undefined)
		: undefined;
	const has = (name: string) => (/[/\\]/.test(name) ? existsSync(name) : onPath(name));
	return factLines({
		model: ready?.model,
		images: ready ? readSupport(supportFile())[provenId(ready.provider.baseUrl, ready.model)] : undefined,
		extension: (status as { version?: string } | undefined)?.version,
		ocr: ocrCommand(process.platform, ocrHelperDir(), has) !== undefined,
		driver: existsSync(driverPath(getAgentDir(), process.platform)),
		mode: permissionMode(),
	});
}

/** Extension factory. */
export default function writerComputerExtension(pi: ExtensionAPI): void {
	const state = newComputerState();
	const breaker = createBreaker();
	const gate = createPermissionGate();
	let client: DriverClient | undefined;

	/** The driver, started on first use. */
	async function driver(): Promise<DriverClient | undefined> {
		const path = driverPath(getAgentDir(), process.platform);
		if (!existsSync(path)) return undefined;
		client ??= await startDriver(path, driverEnv(process.env));
		return client;
	}

	pi.registerTool({
		name: "computer",
		label: "Computer",
		description:
			"Acts on desktop applications through their accessibility tree, in the background.\n\nUsage:\n" +
			" - windows lists windows; read takes a pid and window and numbers the controls as [2]; ref is that number\n" +
			" - Each result is JSON: `next` says who goes on; stop when it is user\n" +
			" - look is a last resort and needs a reason",
		defaultActive: false,
		parameters: Type.Object({
			action: StringEnum(COMPUTER_ACTIONS),
			pid: Type.Optional(Type.Number()),
			window: Type.Optional(Type.Number()),
			name: Type.Optional(Type.String({ description: "launch: the application" })),
			ref: Type.Optional(Type.String({ description: "A control's number from the last read" })),
			text: Type.Optional(Type.String({ description: "type: the string" })),
			key: Type.Optional(Type.String()),
			direction: Type.Optional(Type.String({ description: "scroll: up or down" })),
			amount: Type.Optional(Type.Number()),
			reason: Type.Optional(Type.String({ description: "look: why the tree is not enough" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const result = await runComputer(params as ComputerInput, {
				driver,
				permit: (request) => gate.check(ctx, request),
				breaker,
				state,
				ask: (action, scope) =>
					t(action === "look" ? "browserTool.askLook" : "computerTool.ask", { action, site: scope }),
				vision: sessionVision(pi, ctx),
			});
			if (result.reason === NOT_INSTALLED && ctx.hasUI) ctx.ui.notify(t("computerTool.setup"), "warning");
			return { content: resultContent(result), details: { ...result, data: undefined } };
		},
	});

	/** Settle whether this conversation has the tool, once. */
	function settleTool(ctx: ExtensionContext): void {
		if (!pi.getActiveTools().includes("search_web")) return;
		const known = knownChoice(ctx.sessionManager.getEntries(), TOOL_ENTRY);
		const wanted =
			known ?? (process.env.JW_COMPUTER !== "off" && existsSync(driverPath(getAgentDir(), process.platform)));
		if (known === undefined) pi.appendEntry(TOOL_ENTRY, wanted);
		if (wanted) pi.setActiveTools([...pi.getActiveTools(), "computer"]);
	}

	pi.on("session_start", (_event, ctx) => {
		gate.reset();
		settleTool(ctx);
	});
	pi.on("before_agent_start", () => breaker.reset());
	pi.on("session_shutdown", () => client?.close());
}
