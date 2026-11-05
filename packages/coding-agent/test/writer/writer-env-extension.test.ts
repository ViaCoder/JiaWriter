// Unit tests for the built-in writer-env extension (src/extensions/writer-env/index.ts).

// Temp cache directory.
import { mkdtempSync, rmSync } from "node:fs";
// OS temp directory.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Extension under test.
import writerEnvExtension from "../../src/extensions/writer-env/index.ts";
// Cache helpers.
import { loadDetectCache, type ReasoningSupport, saveDetectCache } from "../../src/writer/api-detect.ts";
// The shared clock offset.
import { clockOffset, setClockOffset } from "../../src/writer/clock.ts";
// Shared startup state.
import {
	buildProviderConfig,
	getWriterModel,
	setWriterModel,
	type WriterModelReady,
} from "../../src/writer/writer-model.ts";

// Temp directories to clean.
const dirs: string[] = [];
// Reset state and files after each test.
afterEach(() => {
	// Initial state.
	setWriterModel({ kind: "none" });
	setClockOffset(0);
	// Delete temp directories.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A ready Anthropic state with a small window, a real cache file and the given reasoning support. */
function readyState(reasoning: ReasoningSupport): WriterModelReady {
	// Cache directory.
	const dir = mkdtempSync(join(tmpdir(), "wa-ext-"));
	// Clean up later.
	dirs.push(dir);
	// Cache file and key.
	const cachePath = join(dir, "api-detect.json");
	// Store the reasoning support so the fallback can update it.
	saveDetectCache(cachePath, "key1", "anthropic-messages", new Date(), reasoning);
	// The state the extension reads.
	return {
		kind: "ready",
		root: "https://h.example.com",
		api: "anthropic-messages",
		source: "detect",
		model: "m1",
		contextWindow: 4_000,
		maxTokens: 128_000,
		reasoning,
		thinkingLevel: "max",
		cachePath,
		cacheKey: "key1",
		provider: buildProviderConfig("https://h.example.com", "anthropic-messages", "m1", 4_000, 128_000, reasoning),
	};
}

/** Minimal fake of the extension API. */
function fakePi(level = "max") {
	// Registered providers.
	const providers: [string, { models: { thinkingLevelMap?: Record<string, string | null> }[] }][] = [];
	// Handlers by event name.
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	// Thinking level of the fake session.
	const session = { level };
	// Notifications shown.
	const notes: string[] = [];
	// Object passed to the factory.
	const pi = {
		// Record a provider registration.
		registerProvider: (name: string, config: (typeof providers)[number][1]) => providers.push([name, config]),
		// Record an event handler.
		on: (event: string, handler: (typeof handlers)[string]) => {
			// Store by name.
			handlers[event] = handler;
		},
		// Current level.
		getThinkingLevel: () => session.level,
		// Change the level.
		setThinkingLevel: (next: string) => {
			// Store it.
			session.level = next;
		},
	};
	// Context of the wa model with a notify sink.
	const ctx = (provider: string) => ({
		model: { provider, id: "m1", api: "anthropic-messages", reasoning: true },
		ui: { notify: (message: string) => notes.push(message) },
	});
	// Expose everything.
	return { pi, providers, handlers, session, notes, ctx };
}

describe("writer-env extension", () => {
	it("registers nothing when JW_* is not ready", () => {
		// Fake API.
		const { pi, providers, handlers } = fakePi();
		// Run the factory with the default "none" state.
		writerEnvExtension(pi as never);
		// No provider; only the time handlers, which every model gets.
		expect([providers.length, Object.keys(handlers).sort()]).toEqual([0, ["after_provider_response", "context"]]);
	});

	it("tells the user once when a local summary was used", () => {
		// Ready state.
		setWriterModel(readyState({ mode: "effort", levels: ALL_LEVELS }));
		const { pi, handlers } = fakePi();
		writerEnvExtension(pi as never);
		const notes: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
		// A model summary says nothing; a local one does.
		handlers.session_compact({ compactionEntry: { details: {} } }, ctx);
		handlers.session_compact({ compactionEntry: { details: { localFallback: true } } }, ctx);
		expect(notes).toHaveLength(1);
	});

	it("registers the wa provider and clamps only wa requests", () => {
		// Ready state.
		setWriterModel(readyState({ mode: "effort", levels: ALL_LEVELS }));
		// Fake API.
		const { pi, providers, handlers, ctx } = fakePi();
		// Run the factory.
		writerEnvExtension(pi as never);
		// Provider "jw" registered.
		expect(providers.map(([name]) => name)).toEqual(["jw"]);
		// A wa request is clamped below the window.
		const out = handlers.before_provider_request({ payload: { max_tokens: 128_000, messages: [] } }, ctx("jw")) as {
			max_tokens: number;
		};
		// Lowered.
		expect(out.max_tokens).toBeLessThan(4_000);
		// Other providers are untouched.
		expect(handlers.before_provider_request({ payload: { max_tokens: 128_000 } }, ctx("openai"))).toBeUndefined();
	});

	it("falls back to the nearest supported level after a reasoning error", () => {
		// Server claimed high and max.
		setWriterModel(readyState({ mode: "effort", levels: ["high", "max"] }));
		// Fake API at level max.
		const { pi, providers, handlers, session, notes, ctx } = fakePi("max");
		// Run the factory.
		writerEnvExtension(pi as never);
		// The reply failed because max is not accepted.
		handlers.message_end(
			{
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "400 Unsupported value for output_config.effort: max",
				},
			},
			ctx("jw"),
		);
		// The session moved to high, the nearest supported level.
		expect(session.level).toBe("high");
		// The provider was registered again with max marked unsupported.
		expect(providers[providers.length - 1][1].models[0].thinkingLevelMap?.max).toBeNull();
		// The cache no longer lists max.
		const state = getWriterModel() as WriterModelReady;
		// Shared state and file agree.
		expect([state.reasoning.levels, loadDetectCache(state.cachePath, state.cacheKey)?.reasoning?.levels]).toEqual([
			["high"],
			["high"],
		]);
		// The user is told in Chinese.
		expect(notes).toEqual(["当前模型不支持「max」推理档，已改用「high」。请重新发送上一条消息。"]);
	});

	it("ignores other errors and other providers", () => {
		// Ready state.
		setWriterModel(readyState({ mode: "effort", levels: ["high", "max"] }));
		// Fake API at level max.
		const { pi, providers, handlers, session, ctx } = fakePi("max");
		// Run the factory.
		writerEnvExtension(pi as never);
		// A network error has nothing to do with reasoning.
		handlers.message_end(
			{ message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed" } },
			ctx("jw"),
		);
		// Another provider's reasoning error.
		handlers.message_end(
			{ message: { role: "assistant", stopReason: "error", errorMessage: "reasoning effort" } },
			ctx("openai"),
		);
		// Level and registrations unchanged.
		expect([session.level, providers.length]).toEqual(["max", 1]);
	});
});

// All five levels.
const ALL_LEVELS = ["low", "medium", "high", "xhigh", "max"];

describe("writer-env time notes", () => {
	it("starts every user message with the local time it was sent", () => {
		// Factory with the default state.
		const { pi, handlers } = fakePi();
		writerEnvExtension(pi as never);
		// One user and one assistant message.
		const messages = [
			{ role: "user", content: "写一篇综述", timestamp: Date.UTC(2026, 10, 3, 10, 42) },
			{ role: "assistant", content: [{ type: "text", text: "好" }], timestamp: Date.UTC(2026, 10, 3, 10, 43) },
		];
		const out = handlers.context({ type: "context", messages }, {}) as { messages: { content: unknown }[] };
		expect(String(out.messages[0].content)).toMatch(/^\[Sent 2026-11-03 \d{2}:\d{2} Tuesday, [^\]]+\]\n写一篇综述$/);
		expect(out.messages[1]).toBe(messages[1]);
	});

	it("corrects the time by the server's Date header once, and tells the user when it is off by two minutes or more", () => {
		// A server ten minutes ahead.
		const { pi, handlers, notes } = fakePi();
		writerEnvExtension(pi as never);
		const ahead = new Date(Date.now() + 10 * 60_000).toUTCString();
		const ui = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
		handlers.after_provider_response({ type: "after_provider_response", status: 200, headers: { Date: ahead } }, ui);
		expect(Math.round(clockOffset() / 60_000)).toBe(10);
		expect(notes).toEqual([
			"本机时钟和模型服务器相差约 10 分钟，已按服务器时间告诉模型当前时间。请检查系统的时间设置。",
		]);
		// Measured once: a later header changes nothing.
		handlers.after_provider_response(
			{ type: "after_provider_response", status: 200, headers: { date: new Date().toUTCString() } },
			ui,
		);
		expect([Math.round(clockOffset() / 60_000), notes.length]).toEqual([10, 1]);
	});

	it("keeps the machine time when the difference is small", () => {
		// Five seconds is network delay and rounding.
		const { pi, handlers, notes } = fakePi();
		writerEnvExtension(pi as never);
		const ui = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
		handlers.after_provider_response(
			{ type: "after_provider_response", status: 200, headers: { date: new Date(Date.now() + 5000).toUTCString() } },
			ui,
		);
		expect([clockOffset(), notes.length]).toEqual([0, 0]);
	});
});
