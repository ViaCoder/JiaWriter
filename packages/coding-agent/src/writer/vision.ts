/**
 * Images as a last resort. Upstreams differ and bill differently, so nothing here estimates a price: the program
 * counts images and limits their size, asks the user, and only then spends anything. Images stay in the history once
 * sent, because rewriting it would lose reasoning on some models; the limits are what keep the cost down.
 */

// The name of an upstream and of a picture.
import { createHash } from "node:crypto";
// The record between sessions.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// Its folder.
import { dirname } from "node:path";

/** Whether an upstream takes images; undefined while nobody knows. */
export type ImageSupport = boolean | undefined;

/** Images allowed. */
export interface ImageLimits {
	// In one message of the user's.
	turn: number;
	// In one session.
	session: number;
}

/** A picture ready for the model. */
export interface Picture {
	data: string;
	mimeType: string;
	// Only some APIs read it.
	detail?: "low" | "auto";
}

/** A picture's place in the page, to turn a point in it back into a point on the page. */
export interface Capture {
	id: string;
	url: string;
	scale: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Images a turn may use unless JW_IMAGE_MAX says otherwise. */
const DEFAULT_LIMITS: ImageLimits = { turn: 1, session: 10 };
/** Longest edge of a picture unless JW_IMAGE_EDGE says otherwise. */
const DEFAULT_EDGE = 1024;
/** Edges that still read. */
const MIN_EDGE = 256;
const MAX_EDGE = 2000;
/** What an upstream says when it takes no images. */
const NO_IMAGE_REPLY = /image|vision|multimodal|multi-modal|input_image|image_url|media/i;
/** A 1×1 PNG: the smallest thing that shows whether images go through. */
export const PROBE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Limits from JW_IMAGE_MAX: "2" for a turn, or "2,20" for a turn and a session. */
export function imageLimits(value: string | undefined): ImageLimits {
	const [turn, session] = (value ?? "").split(",").map((part) => Number.parseInt(part, 10));
	return {
		turn: Number.isInteger(turn) && turn >= 0 ? turn : DEFAULT_LIMITS.turn,
		session: Number.isInteger(session) && session >= 0 ? session : DEFAULT_LIMITS.session,
	};
}

/** The longest edge from JW_IMAGE_EDGE. */
export function imageEdge(value: string | undefined): number {
	const edge = Number.parseInt(value ?? "", 10);
	return Number.isInteger(edge) ? Math.min(Math.max(edge, MIN_EDGE), MAX_EDGE) : DEFAULT_EDGE;
}

/** JW_IMAGE's choice; undefined leaves it to what is known of the upstream. */
export function imageChoice(value: string | undefined): ImageSupport {
	const choice = value?.trim().toLowerCase();
	return choice === "on" ? true : choice === "off" ? false : undefined;
}

/** A picture's name: the same picture is never sent twice. */
export function pictureHash(data: string): string {
	return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

/** The count of images, with what was sent already. */
export interface ImageLedger {
	// Why no image may go now ("" when one may).
	refusal(): "" | "image-budget";
	// True for a picture already with the model.
	seen(hash: string): boolean;
	// Count one sent.
	spend(hash: string): void;
	// A new message from the user.
	newTurn(): void;
	// A new session.
	reset(): void;
}

/** A ledger with nothing spent. */
export function createImageLedger(limits: ImageLimits): ImageLedger {
	const sent = new Set<string>();
	let inTurn = 0;
	let inSession = 0;
	return {
		refusal: () => (inTurn >= limits.turn || inSession >= limits.session ? "image-budget" : ""),
		seen: (hash) => sent.has(hash),
		spend(hash) {
			sent.add(hash);
			inTurn++;
			inSession++;
		},
		newTurn() {
			inTurn = 0;
		},
		reset() {
			sent.clear();
			inTurn = 0;
			inSession = 0;
		},
	};
}

/** What was found out about upstreams; a missing or broken file knows nothing. */
export function readSupport(file: string): Record<string, boolean> {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as Record<string, boolean>;
	} catch {
		// Not there yet.
		return {};
	}
}

/** Keep what was found out; a failure only means finding out again. */
export function saveSupport(file: string, id: string, supported: boolean): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const staged = `${file}.${process.pid}.tmp`;
		writeFileSync(staged, JSON.stringify({ ...readSupport(file), [id]: supported }), { mode: 0o600 });
		renameSync(staged, file);
	} catch {
		// Costs one more probe.
	}
}

/** What a model list says of a model, such as OpenRouter's input_modalities; undefined when it says nothing. */
export function listedSupport(list: unknown, modelId: string): ImageSupport {
	const models = (list as { data?: { id?: string; architecture?: { input_modalities?: unknown } }[] }).data;
	const modalities = models?.find((m) => m.id === modelId)?.architecture?.input_modalities;
	return Array.isArray(modalities) ? modalities.includes("image") : undefined;
}

/** True when an upstream's error says images are the problem; anything else proves nothing. */
export function saysNoImages(message: string): boolean {
	return /\b4\d\d\b/.test(message) && NO_IMAGE_REPLY.test(message);
}

/** What finding out needs. */
export interface SupportSources {
	// JW_IMAGE.
	choice: ImageSupport;
	// The model's own declaration, when it has one.
	declared: ImageSupport;
	// What an earlier session found.
	remembered: ImageSupport;
	// The upstream's model list.
	listed(): Promise<ImageSupport>;
	// One tiny request; spends tokens, so it comes last and after the user agreed.
	probe(): Promise<ImageSupport>;
}

/** Whether an upstream takes images, from the cheapest source that knows. */
export async function imageSupport(sources: SupportSources): Promise<ImageSupport> {
	return (
		sources.choice ??
		sources.declared ??
		sources.remembered ??
		(await sources.listed().catch(() => undefined)) ??
		(await sources.probe().catch(() => undefined))
	);
}

/** The point on the page of a point in a picture. */
export function pagePoint(capture: Capture, x: number, y: number): { x: number; y: number } | undefined {
	const inside = x >= 0 && y >= 0 && x <= capture.width * capture.scale && y <= capture.height * capture.scale;
	return inside ? { x: capture.x + x / capture.scale, y: capture.y + y / capture.scale } : undefined;
}

/** The one ledger of this process: pages, the desktop and files share the limits. */
const LEDGER_KEY = Symbol.for("jiawriter.imageLedger");
const holder = globalThis as Record<symbol, ImageLedger | undefined>;

/** The shared ledger. */
export function sharedLedger(env: NodeJS.ProcessEnv = process.env): ImageLedger {
	holder[LEDGER_KEY] ??= createImageLedger(imageLimits(env.JW_IMAGE_MAX));
	return holder[LEDGER_KEY];
}
