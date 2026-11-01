// Unit tests for the built-in writer-env extension (src/extensions/writer-env/index.ts).

// Test API.
import { afterEach, describe, expect, it } from "vitest";
// Extension under test.
import writerEnvExtension from "../../src/extensions/writer-env/index.ts";
// Shared startup state.
import { buildProviderConfig, setWriterModel } from "../../src/writer/writer-model.ts";

// Reset the shared state after each test.
afterEach(() => setWriterModel({ kind: "none" }));

/** Minimal fake of the extension API: records provider registrations and handlers. */
function fakePi() {
	// Registered providers.
	const providers: [string, unknown][] = [];
	// Registered event handlers by event name.
	const handlers: Record<string, (event: { payload: unknown }, ctx: { model?: { provider: string } }) => unknown> = {};
	// Object passed to the factory.
	const pi = {
		// Record a provider registration.
		registerProvider: (name: string, config: unknown) => providers.push([name, config]),
		// Record an event handler.
		on: (event: string, handler: (typeof handlers)[string]) => {
			// Store by name.
			handlers[event] = handler;
		},
	};
	// Expose all three.
	return { pi, providers, handlers };
}

describe("writer-env extension", () => {
	it("registers nothing when WA_* is not ready", () => {
		// Fake API.
		const { pi, providers, handlers } = fakePi();
		// Run the factory with the default "none" state.
		writerEnvExtension(pi as never);
		// No provider, no handler.
		expect([providers.length, Object.keys(handlers).length]).toEqual([0, 0]);
	});

	it("registers the wa provider and clamps only wa requests", () => {
		// Ready state with a small window.
		setWriterModel({
			kind: "ready",
			api: "anthropic-messages",
			source: "env",
			model: "m1",
			contextWindow: 4_000,
			maxTokens: 128_000,
			provider: buildProviderConfig("https://h.example.com", "anthropic-messages", "m1", 4_000, 128_000),
		});
		// Fake API.
		const { pi, providers, handlers } = fakePi();
		// Run the factory.
		writerEnvExtension(pi as never);
		// Provider "wa" registered with the key reference.
		expect(providers.map(([name, config]) => [name, (config as { apiKey: string }).apiKey])).toEqual([
			["wa", "$WA_KEY"],
		]);
		// The request hook.
		const hook = handlers.before_provider_request;
		// A wa request is clamped below the window.
		const out = hook({ payload: { max_tokens: 128_000, messages: [] } }, { model: { provider: "wa" } }) as {
			max_tokens: number;
		};
		// Lowered.
		expect(out.max_tokens).toBeLessThan(4_000);
		// Other providers are untouched.
		expect(hook({ payload: { max_tokens: 128_000 } }, { model: { provider: "openai" } })).toBeUndefined();
	});
});
