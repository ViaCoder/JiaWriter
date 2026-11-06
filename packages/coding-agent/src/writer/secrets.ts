/**
 * Keys live only in this process's memory. The user exports JW_KEY (model API) and ANYSEARCH_KEY
 * (AnySearch) before starting JiaWriter; at startup takeSecrets() moves both values here and deletes
 * them from process.env, so no child process (bash, sf, fd, rg, MCP servers) inherits them, and nothing
 * writes them to a file. Readers ask secret() or build an environment view with withSecrets().
 */

// The provider auth context type (environment and file lookups for credentials).
import type { AuthContext } from "@earendil-works/pi-ai";

/** The variables that hold keys. */
export const SECRET_VARS = ["JW_KEY", "ANYSEARCH_KEY"] as const;

/** Where the values live: one map per process on globalThis, so every copy of this module (the extension
 * loader evaluates some modules a second time) reads the same values. A Symbol.for key is not enumerable
 * as a string property and never reaches a child process. */
const HELD_KEY = Symbol.for("jiawriter.secrets");
/** The process-wide holder on globalThis. */
const holder = globalThis as Record<symbol, Map<string, string> | undefined>;
// Created by the first copy of this module that runs.
if (!holder[HELD_KEY]) holder[HELD_KEY] = new Map<string, string>();
/** Values taken at startup, by variable name. */
const held: Map<string, string> = holder[HELD_KEY];

/** Move the key variables of env into memory and delete them from env; returns the names taken. */
export function takeSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
	// Names found.
	const taken: string[] = [];
	for (const name of SECRET_VARS) {
		// Only a value that is there.
		const value = env[name];
		if (value === undefined) continue;
		// Into memory, out of the environment.
		held.set(name, value);
		delete env[name];
		taken.push(name);
	}
	return taken;
}

/** The value taken for name, if any. */
export function secret(name: string): string | undefined {
	// Memory only.
	return held.get(name);
}

/** A copy of env with the taken keys added back, for readers of the configuration (never for a child process). */
export function withSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	// The variables as they are now.
	const view: NodeJS.ProcessEnv = { ...env };
	// A value still in env wins (SDK use without takeSecrets).
	for (const [name, value] of held) if (view[name] === undefined) view[name] = value;
	return view;
}

/** Forget every taken value (tests). */
export function clearSecrets(): void {
	// Empty the map.
	held.clear();
}

/** base, with variables it cannot find read from the keys held in memory (provider credential checks). */
export function withSecretAuthContext(base: AuthContext): AuthContext {
	return {
		// The environment first, then memory.
		env: async (name) => (await base.env(name)) ?? secret(name),
		// File lookups unchanged.
		fileExists: (path) => base.fileExists(path),
	};
}
