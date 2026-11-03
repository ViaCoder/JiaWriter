// Tests for src/writer/secrets.ts: keys move from the environment into memory.
// A real child process.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
	clearSecrets,
	SECRET_VARS,
	secret,
	takeSecrets,
	withSecretAuthContext,
	withSecrets,
} from "../../src/writer/secrets.ts";

afterEach(() => clearSecrets());

describe("takeSecrets", () => {
	test("moves JW_KEY and JW_SEARCH_KEY out of the environment and leaves the rest", () => {
		// A test environment, not process.env.
		const env: NodeJS.ProcessEnv = {
			JW_KEY: "sk-test-1",
			JW_SEARCH_KEY: "as-test-2",
			JW_URL: "https://api.example.com",
		};
		expect(takeSecrets(env)).toEqual(["JW_KEY", "JW_SEARCH_KEY"]);
		// Gone from the environment a child process would inherit.
		expect(env).toEqual({ JW_URL: "https://api.example.com" });
		// Kept in memory.
		expect(secret("JW_KEY")).toBe("sk-test-1");
		expect(secret("JW_SEARCH_KEY")).toBe("as-test-2");
	});

	test("takes nothing when no key is set", () => {
		// Empty environment.
		expect(takeSecrets({})).toEqual([]);
		expect(secret("JW_KEY")).toBeUndefined();
	});

	test("covers exactly the two key variables", () => {
		// The list the module guards.
		expect([...SECRET_VARS]).toEqual(["JW_KEY", "JW_SEARCH_KEY"]);
	});
});

describe("withSecrets", () => {
	test("adds the taken keys to a copy and never changes the original", () => {
		// Take, then build a view.
		const env: NodeJS.ProcessEnv = { JW_KEY: "sk-test-1", JW_MODEL: "m1" };
		takeSecrets(env);
		const view = withSecrets(env);
		expect(view).toEqual({ JW_MODEL: "m1", JW_KEY: "sk-test-1" });
		// The original stays without the key.
		expect(env.JW_KEY).toBeUndefined();
	});

	test("lets a value still in the environment win", () => {
		// SDK use: the key was never taken.
		const env: NodeJS.ProcessEnv = { JW_KEY: "sk-later" };
		takeSecrets({ JW_KEY: "sk-earlier" });
		expect(withSecrets(env).JW_KEY).toBe("sk-later");
	});
});

describe("clearSecrets", () => {
	test("forgets every value", () => {
		// Take, clear, look.
		takeSecrets({ JW_KEY: "sk-test-1" });
		clearSecrets();
		expect(secret("JW_KEY")).toBeUndefined();
	});
});

describe("child processes", () => {
	test("do not inherit a key once it is taken from process.env", () => {
		// The key as the user exports it, kept aside to restore the worker's environment.
		const before = process.env.JW_KEY;
		process.env.JW_KEY = "sk-child-check";
		try {
			takeSecrets();
			// A child with the default (inherited) environment reports whether it sees the variable.
			const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String('JW_KEY' in process.env))"], {
				encoding: "utf-8",
			});
			expect(r.stdout).toBe("false");
			// The parent still has it in memory.
			expect(secret("JW_KEY")).toBe("sk-child-check");
		} finally {
			if (before === undefined) delete process.env.JW_KEY;
			else process.env.JW_KEY = before;
		}
	});
});

describe("withSecretAuthContext", () => {
	test("reads the environment first, then the keys in memory, and passes file checks through", async () => {
		// A base context that knows one variable and one file.
		const base = {
			env: async (name: string) => (name === "JW_URL" ? "https://api.example.com" : undefined),
			fileExists: async (path: string) => path === "/etc/example",
		};
		takeSecrets({ JW_KEY: "sk-test-1" });
		const ctx = withSecretAuthContext(base);
		expect(await ctx.env("JW_URL")).toBe("https://api.example.com");
		expect(await ctx.env("JW_KEY")).toBe("sk-test-1");
		expect(await ctx.env("JW_OTHER")).toBeUndefined();
		expect(await ctx.fileExists("/etc/example")).toBe(true);
	});
});
