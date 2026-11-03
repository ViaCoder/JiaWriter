// Unit tests for the JiaWriter package-command and self-update guards.

// Test API.
import { describe, expect, it } from "vitest";
// Brand guard.
import { selfUpdateSupported } from "../../src/config.ts";
// Package command helpers.
import { isPackageCommandInvocation, updateTargetWantsSelf } from "../../src/package-manager-cli.ts";

describe("selfUpdateSupported", () => {
	it("is false for the jiawriter brand and true for upstream pi", () => {
		// Release builds carry the jiawriter brand.
		expect(selfUpdateSupported("jiawriter")).toBe(false);
		// The source tree keeps the upstream brand.
		expect(selfUpdateSupported("pi")).toBe(true);
	});
});

describe("isPackageCommandInvocation", () => {
	it("recognizes install, remove, update and list", () => {
		// Each explicit package command.
		for (const args of [["install", "npm:x"], ["remove", "npm:x"], ["update"], ["list"]]) {
			// Recognized.
			expect(isPackageCommandInvocation(args)).toBe(true);
		}
	});

	it("does not treat prompts or other flags as package commands", () => {
		// A normal prompt, print mode and an empty argument list.
		for (const args of [["写一篇报告"], ["-p", "hello"], []]) {
			// Not a package command.
			expect(isPackageCommandInvocation(args)).toBe(false);
		}
	});
});

describe("updateTargetWantsSelf", () => {
	it("covers all and self, not extensions or models", () => {
		// The program itself is part of these targets.
		expect([updateTargetWantsSelf({ type: "all" }), updateTargetWantsSelf({ type: "self" })]).toEqual([true, true]);
		// Not part of these.
		expect([updateTargetWantsSelf({ type: "extensions" }), updateTargetWantsSelf({ type: "models" })]).toEqual([
			false,
			false,
		]);
	});
});
