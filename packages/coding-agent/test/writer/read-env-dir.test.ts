// Unit tests for readEnvDir() in src/config.ts (JiaWriter short env names).

// vitest helpers; stubEnv restores variables after each test.
import { afterEach, describe, expect, it, vi } from "vitest";
// Function and names under test.
import {
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	LEGACY_ENV_AGENT_DIR,
	LEGACY_ENV_SESSION_DIR,
	readEnvDir,
} from "../../src/config.ts";

describe("readEnvDir", () => {
	// Undo every stubbed variable so tests stay independent.
	afterEach(() => vi.unstubAllEnvs());

	it("uses the short JiaWriter names", () => {
		// The public names are short.
		expect(ENV_AGENT_DIR).toBe("JW_DIR");
		expect(ENV_SESSION_DIR).toBe("JW_SESSION_DIR");
	});

	it("returns the JiaWriter variable when only it is set", () => {
		// Only the new name holds a value.
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/wa-a");
		vi.stubEnv(LEGACY_ENV_AGENT_DIR, "");
		// The new value is returned.
		expect(readEnvDir(ENV_AGENT_DIR, LEGACY_ENV_AGENT_DIR)).toBe("/tmp/wa-a");
	});

	it("falls back to the upstream variable when the new one is unset or empty", () => {
		// New name empty, upstream name set.
		vi.stubEnv(ENV_SESSION_DIR, "");
		vi.stubEnv(LEGACY_ENV_SESSION_DIR, "/tmp/legacy-s");
		// The upstream value is used.
		expect(readEnvDir(ENV_SESSION_DIR, LEGACY_ENV_SESSION_DIR)).toBe("/tmp/legacy-s");
	});

	it("prefers the JiaWriter variable when both are set", () => {
		// Both names hold values.
		vi.stubEnv(ENV_AGENT_DIR, "/tmp/new");
		vi.stubEnv(LEGACY_ENV_AGENT_DIR, "/tmp/old");
		// The new name wins.
		expect(readEnvDir(ENV_AGENT_DIR, LEGACY_ENV_AGENT_DIR)).toBe("/tmp/new");
	});

	it("returns undefined when neither variable has a value", () => {
		// Both names empty.
		vi.stubEnv(ENV_AGENT_DIR, "");
		vi.stubEnv(LEGACY_ENV_AGENT_DIR, "");
		// Nothing is configured.
		expect(readEnvDir(ENV_AGENT_DIR, LEGACY_ENV_AGENT_DIR)).toBeUndefined();
	});
});
