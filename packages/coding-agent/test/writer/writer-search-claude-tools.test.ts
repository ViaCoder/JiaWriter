// claudeTools and forgetProven (src/extensions/writer-search/index.ts), through the extension's own events: a Claude
// conversation carries the upstream tools its first request was given, keeps them in the session, and drops them
// for good once the upstream refuses one. No network: the extension only changes the request's body here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import writerSearchExtension from "../../src/extensions/writer-search/index.ts";
import { provenId, writeProven } from "../../src/writer/websearch/main-search.ts";

// The test's own agent folder, so proven.json is the test's.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jw-claude-tools-"));
	vi.stubEnv("JW_DIR", join(dir, "agent"));
	vi.stubEnv("JW_LANG", "en");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** The upstream of the test. */
const MODEL = { api: "anthropic-messages", baseUrl: "https://llm.example.com", id: "m1" };

/** The extension with its handlers and the session entries it adds; every other part of the API does nothing. */
function loaded() {
	const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
	const entries: unknown[] = [];
	const named: Record<string, unknown> = {
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
			handlers[name] ??= [];
			handlers[name].push(fn);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getThinkingLevel: () => "off",
	};
	// Anything else the extension registers is accepted and ignored.
	const pi = new Proxy(named, { get: (target, key: string) => target[key] ?? (() => undefined) });
	writerSearchExtension(pi as unknown as ExtensionAPI);
	const ctx = {
		model: MODEL,
		cwd: dir,
		hasUI: false,
		ui: { notify: () => undefined },
		sessionManager: { getEntries: () => entries },
		// No key: the search log has nothing to keep out.
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) },
	};
	/** One request as the provider would send it; the body the extension makes of it, or undefined. */
	const request = (payload: unknown) =>
		handlers.before_provider_request?.map((fn) => fn({ payload }, ctx)).find((out) => out !== undefined) as
			| Record<string, unknown>
			| undefined;
	/** The end of a turn. */
	const turnEnd = async (message: unknown) => {
		for (const fn of handlers.turn_end ?? []) await fn({ message, turnIndex: 0 }, ctx);
	};
	return { request, turnEnd, entries };
}

/** A request body: the tools of the agent, and the messages so far. */
function body(roles: string[]) {
	return { tools: [{ name: "read" }], messages: roles.map((role) => ({ role, content: "x" })) };
}

/** Whether the body carries the upstream's own search tool. */
function hasSearch(out: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(out?.tools ?? []).includes("web_search");
}

describe("claudeTools", () => {
	it("gives a new conversation the tools on record, keeps them in the session, and keeps them later", () => {
		writeProven(join(dir, "agent", "proven.json"), { [provenId(MODEL.baseUrl, MODEL.id)]: ["search"] });
		const { request, entries } = loaded();
		// The first request: nothing the model said depends on the tools yet.
		expect(hasSearch(request(body(["user"])))).toBe(true);
		expect(entries).toEqual([
			expect.objectContaining({
				customType: "jiawriter-fixed-tools",
				data: expect.objectContaining({ tools: ["search"] }),
			}),
		]);
		// A later request of the same conversation carries the same set, and nothing new is recorded.
		expect(hasSearch(request(body(["user", "assistant", "user"])))).toBe(true);
		expect(entries.length).toBe(1);
	});

	it("leaves a conversation under way without them, so its earlier reasoning stays valid", () => {
		writeProven(join(dir, "agent", "proven.json"), { [provenId(MODEL.baseUrl, MODEL.id)]: ["search"] });
		const { request } = loaded();
		expect(hasSearch(request(body(["user", "assistant", "user"])))).toBe(false);
	});
});

describe("forgetProven", () => {
	it("drops a tool the upstream refused, from the record and from the conversation", async () => {
		const file = join(dir, "agent", "proven.json");
		writeProven(file, { [provenId(MODEL.baseUrl, MODEL.id)]: ["search"] });
		const { request, turnEnd } = loaded();
		expect(hasSearch(request(body(["user"])))).toBe(true);
		// The upstream refused the tool.
		await turnEnd({
			role: "assistant",
			content: [],
			api: MODEL.api,
			stopReason: "error",
			errorMessage: "400 web_search is not supported",
		});
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({});
		// The next request of the conversation goes without it.
		expect(hasSearch(request(body(["user", "assistant", "user"])))).toBe(false);
	});
});
