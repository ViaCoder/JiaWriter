// Images as a last resort (src/writer/vision.ts): limits, the ledger, and finding out what an upstream takes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createImageLedger,
	imageChoice,
	imageEdge,
	imageLimits,
	imageSupport,
	listedSupport,
	PROBE_PNG,
	pagePoint,
	pictureHash,
	readSupport,
	saveSupport,
	saysNoImages,
	sharedLedger,
} from "../../src/writer/vision.ts";

describe("imageLimits, imageEdge and imageChoice", () => {
	it("reads JW_IMAGE_MAX", () => {
		expect(imageLimits(undefined)).toEqual({ turn: 1, session: 10 });
		expect(imageLimits("3")).toEqual({ turn: 3, session: 10 });
		expect(imageLimits("2,20")).toEqual({ turn: 2, session: 20 });
		expect(imageLimits("0,0")).toEqual({ turn: 0, session: 0 });
		expect(imageLimits("x,-1")).toEqual({ turn: 1, session: 10 });
	});
	it("keeps JW_IMAGE_EDGE to what still reads", () => {
		expect(imageEdge(undefined)).toBe(1024);
		expect(imageEdge("800")).toBe(800);
		expect(imageEdge("10")).toBe(256);
		expect(imageEdge("9000")).toBe(2000);
		expect(imageEdge("x")).toBe(1024);
	});
	it("reads JW_IMAGE", () => {
		expect(imageChoice(" ON ")).toBe(true);
		expect(imageChoice("off")).toBe(false);
		expect(imageChoice(undefined)).toBeUndefined();
		expect(imageChoice("maybe")).toBeUndefined();
	});
});

describe("pictureHash", () => {
	it("tells pictures apart", () => {
		expect(pictureHash("a")).toBe(pictureHash("a"));
		expect(pictureHash("a")).not.toBe(pictureHash("b"));
	});
	it("hashes a 1 MB picture in under 20 ms", () => {
		const data = "x".repeat(1024 * 1024);
		const started = performance.now();
		pictureHash(data);
		expect(performance.now() - started).toBeLessThan(20);
	});
});

describe("createImageLedger", () => {
	it("holds to the turn and the session", () => {
		const ledger = createImageLedger({ turn: 1, session: 2 });
		expect(ledger.refusal()).toBe("");
		ledger.spend("a");
		expect(ledger.seen("a")).toBe(true);
		expect(ledger.refusal()).toBe("image-budget");
		ledger.newTurn();
		expect(ledger.refusal()).toBe("");
		ledger.spend("b");
		ledger.newTurn();
		expect(ledger.refusal()).toBe("image-budget");
		ledger.reset();
		expect(ledger.refusal()).toBe("");
		expect(ledger.seen("a")).toBe(false);
	});
});

describe("sharedLedger", () => {
	it("is the same for everyone in the process", () => {
		expect(sharedLedger()).toBe(sharedLedger());
	});
});

describe("readSupport and saveSupport", () => {
	it("remembers both answers, and survives a broken file", () => {
		const dir = mkdtempSync(join(tmpdir(), "jw-vision-"));
		const file = join(dir, "deep", "vision.json");
		expect(readSupport(file)).toEqual({});
		saveSupport(file, "a", true);
		saveSupport(file, "b", false);
		expect(readSupport(file)).toEqual({ a: true, b: false });
		writeFileSync(file, "not json");
		expect(readSupport(file)).toEqual({});
		rmSync(dir, { recursive: true });
	});
});

describe("listedSupport", () => {
	const list = {
		data: [
			{ id: "a", architecture: { input_modalities: ["text", "image"] } },
			{ id: "b", architecture: { input_modalities: ["text"] } },
			{ id: "c" },
		],
	};
	it("reads what a list declares, and nothing else", () => {
		expect(listedSupport(list, "a")).toBe(true);
		expect(listedSupport(list, "b")).toBe(false);
		expect(listedSupport(list, "c")).toBeUndefined();
		expect(listedSupport(list, "d")).toBeUndefined();
		expect(listedSupport({}, "a")).toBeUndefined();
	});
});

describe("saysNoImages", () => {
	it("takes only a client error about images as a no", () => {
		expect(saysNoImages("400 this model does not support image input")).toBe(true);
		expect(saysNoImages("Error 422: vision is not enabled")).toBe(true);
		expect(saysNoImages("500 image service down")).toBe(false);
		expect(saysNoImages("429 rate limit")).toBe(false);
		expect(saysNoImages("fetch failed")).toBe(false);
	});
});

describe("imageSupport", () => {
	const never = async () => {
		throw new Error("must not be called");
	};
	const quiet = {
		choice: undefined,
		declared: undefined,
		remembered: undefined,
		listed: async () => undefined,
		probe: async () => undefined,
	};

	it("stops at the cheapest source that knows", async () => {
		expect(await imageSupport({ ...quiet, choice: false, listed: never, probe: never })).toBe(false);
		expect(await imageSupport({ ...quiet, declared: true, listed: never, probe: never })).toBe(true);
		expect(await imageSupport({ ...quiet, remembered: false, listed: never, probe: never })).toBe(false);
		expect(await imageSupport({ ...quiet, listed: async () => true, probe: never })).toBe(true);
		expect(await imageSupport({ ...quiet, probe: async () => false })).toBe(false);
	});

	it("treats a failure as not knowing", async () => {
		expect(await imageSupport({ ...quiet, listed: never, probe: never })).toBeUndefined();
	});
});

describe("pagePoint", () => {
	const capture = { id: "c", url: "u", scale: 0.5, x: 10, y: 20, width: 200, height: 100 };
	it("undoes the scale and the offset", () => {
		expect(pagePoint(capture, 50, 25)).toEqual({ x: 110, y: 70 });
	});
	it("refuses a point outside the picture", () => {
		expect(pagePoint(capture, 101, 0)).toBeUndefined();
		expect(pagePoint(capture, 0, 51)).toBeUndefined();
		expect(pagePoint(capture, -1, 0)).toBeUndefined();
	});
});

describe("PROBE_PNG", () => {
	it("is a real, tiny PNG", () => {
		const bytes = Buffer.from(PROBE_PNG, "base64");
		expect(bytes.subarray(1, 4).toString()).toBe("PNG");
		expect(bytes.length).toBeLessThan(100);
	});
});
