/**
 * Built-in JiaWriter extension: finds out whether an upstream takes images, once and only when one is needed, and
 * holds every image to the same limits and the same permission, also when the read tool opens a picture.
 */

// Reading a picture on this machine.
import { existsSync } from "node:fs";
// Paths.
import { extname, join } from "node:path";
// Finding out with one tiny request.
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
// Where it is kept, and the program's assets.
import { getAgentDir } from "../../config.ts";
// Extension API types.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
// The record of upstreams.
import type { BrowserVision } from "../../writer/browser/agent.ts";
// The JW model's provider.
import { JW_PROVIDER } from "../../writer/env-config.ts";
// Output messages.
import { t } from "../../writer/i18n/index.ts";
import { ocrCommand, ocrHelperDir, ocrText, onPath } from "../../writer/ocr.ts";
// Questions to the user.
import { createPermissionGate } from "../../writer/permission.ts";
// The JW model's secrets and state.
import { secret } from "../../writer/secrets.ts";
import {
	type ImageSupport,
	imageChoice,
	imageEdge,
	imageSupport,
	listedSupport,
	PROBE_PNG,
	readSupport,
	saveSupport,
	saysNoImages,
	sharedLedger,
} from "../../writer/vision.ts";
// The name of an upstream.
import { provenId } from "../../writer/websearch/main-search.ts";
import { buildImagesProvider } from "../../writer/writer-model.ts";

/** Files the read tool shows as pictures. */
const PICTURES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
/** How long the model list gets (ms). */
const LIST_MS = 5000;

/** True for a path the read tool would send as a picture. */
export function isPicturePath(path: string): boolean {
	return PICTURES.has(extname(path).toLowerCase());
}

/** The file that remembers what upstreams take. */
export function supportFile(): string {
	return join(getAgentDir(), "vision.json");
}

/** What an upstream's model list says, without spending anything. */
export async function listSupport(model: Model<Api>): Promise<ImageSupport> {
	const key = secret("JW_KEY");
	const reply = await fetch(`${model.baseUrl.replace(/\/$/, "")}/models`, {
		headers: key ? { authorization: `Bearer ${key}` } : {},
		signal: AbortSignal.timeout(LIST_MS),
	});
	return reply.ok ? listedSupport(await reply.json(), model.id) : undefined;
}

/** One tiny request with a 1×1 picture; only a clear refusal counts as no. */
export async function probeSupport(model: Model<Api>): Promise<ImageSupport> {
	const reply = await completeSimple(
		{ ...model, input: ["text", "image"], maxTokens: 16 },
		{
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Reply OK." },
						{ type: "image", data: PROBE_PNG, mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: secret("JW_KEY") },
	);
	if (reply.stopReason !== "error") return true;
	return saysNoImages(reply.errorMessage ?? "") ? false : undefined;
}

/** Whether the session's model takes images, remembered once found. */
export async function findSupport(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ImageSupport> {
	const model = ctx.model;
	if (!model) return false;
	const id = provenId(model.baseUrl, model.id);
	const custom = model.provider === JW_PROVIDER;
	const found = await imageSupport({
		choice: imageChoice(process.env.JW_IMAGE),
		declared: model.input.includes("image") ? true : custom ? undefined : false,
		remembered: readSupport(supportFile())[id],
		listed: () => listSupport(model),
		probe: () => probeSupport(model),
	});
	if (found !== undefined) saveSupport(supportFile(), id, found);
	// The model must say so too, or images are stripped on the way out.
	if (found === true && custom && !model.input.includes("image")) {
		const provider = buildImagesProvider();
		if (provider) pi.registerProvider(JW_PROVIDER, provider);
	}
	return found;
}

/** What the browser and computer tools need for this session. */
export function sessionVision(pi: ExtensionAPI, ctx: ExtensionContext): BrowserVision {
	const ocr = ocrCommand(process.platform, ocrHelperDir(), (name) =>
		name.includes("/") || name.includes("\\") ? existsSync(name) : onPath(name),
	);
	return {
		edge: imageEdge(process.env.JW_IMAGE_EDGE),
		ledger: sharedLedger(),
		ocr: (data) => (process.env.JW_OCR === "off" ? Promise.resolve("") : ocrText(data, ocr)),
		supported: () => findSupport(pi, ctx),
	};
}

/** Extension factory. */
export default function writerVisionExtension(pi: ExtensionAPI): void {
	const gate = createPermissionGate();
	pi.on("session_start", (_event, ctx) => {
		sharedLedger().reset();
		gate.reset();
		// Known from an earlier session or by choice: the model says so from its first request.
		const model = ctx.model;
		if (model?.provider !== JW_PROVIDER) return;
		const known = imageChoice(process.env.JW_IMAGE) ?? readSupport(supportFile())[provenId(model.baseUrl, model.id)];
		const provider = known === true ? buildImagesProvider() : undefined;
		if (provider) pi.registerProvider(JW_PROVIDER, provider);
	});
	pi.on("before_agent_start", () => sharedLedger().newTurn());
	// A picture read from a file counts like any other.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read" || !ctx.model?.input.includes("image")) return undefined;
		const path = String((event.input as { path?: unknown }).path ?? "");
		if (!isPicturePath(path)) return undefined;
		const over = sharedLedger().refusal();
		const refusal =
			over ||
			(await gate.check(ctx, { risk: "high", scope: "file", title: t("browserTool.askFile"), detail: path }));
		if (refusal) return { block: true, reason: t("browserTool.fileRefused", { path }) };
		sharedLedger().spend(`file:${path}:${Date.now()}`);
		return undefined;
	});
}
