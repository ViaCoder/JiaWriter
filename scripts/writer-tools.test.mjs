// Tests for scripts/writer-tools.mjs (node:test; archives built on the spot, fake downloads, no network).

// Assertions.
import assert from "node:assert/strict";
// Archive tools.
import { execFileSync } from "node:child_process";
// Hashing.
import { createHash } from "node:crypto";
// Files.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// Temp folder.
import { tmpdir } from "node:os";
// Path helpers.
import { join } from "node:path";
// Test runner.
import { afterEach, beforeEach, test } from "node:test";
// Functions under test.
import { assetUrl, cachedArchive, installTool, installTools, PINS, sha256File } from "./writer-tools.mjs";

// Archives are built and unpacked with tar and zip, as on the Linux build machine.
const NO_ZIP = process.platform === "win32" ? "packaging runs on the Linux build machine" : false;

// Work folder of each test.
let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-tools-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete PINS.fake;
});

/** A tar.gz (or zip) holding <top>/<exe> and <top>/LICENSE-MIT; returns its path and bytes. */
function archive(name, exe, zip = false) {
	// Contents.
	const src = join(dir, `src-${name}`);
	mkdirSync(join(src, "top"), { recursive: true });
	writeFileSync(join(src, "top", exe), "#!/bin/sh\necho ok\n");
	writeFileSync(join(src, "top", "LICENSE-MIT"), "MIT");
	writeFileSync(join(src, "top", "README.md"), "readme");
	const out = join(dir, name);
	if (zip) execFileSync("zip", ["-qr", out, "top"], { cwd: src });
	else execFileSync("tar", ["-czf", out, "-C", src, "top"]);
	return { path: out, bytes: readFileSync(out) };
}

/** Pin a fake tool to an archive's digest. */
function pinFake(platform, name, bytes) {
	// Same shape as the real pins.
	PINS.fake = { repo: "o/fake", version: "v1", assets: { [platform]: [name, createHash("sha256").update(bytes).digest("hex")] } };
}

test("pins cover both tools on all six platforms and build GitHub URLs", () => {
	// Platforms.
	const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];
	for (const tool of ["fd", "rg"]) assert.deepEqual(Object.keys(PINS[tool].assets).sort(), [...platforms].sort());
	// Every digest is 64 hex characters; Linux uses the static musl builds.
	assert.ok(Object.values(PINS).every((p) => Object.values(p.assets).every(([, d]) => /^[0-9a-f]{64}$/.test(d))));
	assert.ok(PINS.rg.assets["linux-arm64"][0].includes("musl"));
	assert.equal(assetUrl("fd", "linux-x64"), "https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz");
});

test("cachedArchive downloads once, reuses the cache, and refuses a wrong digest", { skip: NO_ZIP }, async () => {
	// A good archive.
	const a = archive("fake.tar.gz", "fake");
	pinFake("linux-x64", "fake.tar.gz", a.bytes);
	let calls = 0;
	const fetchFn = async () => {
		calls++;
		return { ok: true, status: 200, arrayBuffer: async () => a.bytes };
	};
	const cache = join(dir, "cache");
	const p = await cachedArchive("fake", "linux-x64", cache, fetchFn);
	assert.equal(sha256File(p), PINS.fake.assets["linux-x64"][1]);
	await cachedArchive("fake", "linux-x64", cache, fetchFn);
	assert.equal(calls, 1);
	// A tampered cache entry is removed and refused.
	writeFileSync(p, "tampered");
	await assert.rejects(cachedArchive("fake", "linux-x64", cache, fetchFn), /SHA256 .* does not match/);
	assert.equal(existsSync(p), false);
	// HTTP errors and unknown platforms.
	await assert.rejects(cachedArchive("fake", "linux-x64", join(dir, "c2"), async () => ({ ok: false, status: 404 })), /HTTP 404/);
	await assert.rejects(cachedArchive("fd", "solaris-x64", cache, fetchFn), /no pinned fd/);
});

test("installTool puts only the executable in the package (bin/), for tar.gz and zip", { skip: NO_ZIP }, () => {
	// Unix archive.
	const pkg = join(dir, "pkg");
	const fd = installTool("fd", "linux-x64", archive("fd.tar.gz", "fd").path, pkg);
	assert.equal(fd, join(pkg, "bin", "fd"));
	assert.equal(statSync(fd).mode & 0o777, 0o755);
	// The archive's license file stays out of the package.
	assert.equal(existsSync(join(pkg, "THIRD_PARTY")), false);
	// Windows archive.
	const rg = installTool("rg", "windows-x64", archive("rg.zip", "rg.exe", true).path, pkg);
	assert.equal(rg, join(pkg, "bin", "rg.exe"));
	// The executable must be there.
	assert.throws(() => installTool("rg", "linux-x64", archive("bad.tar.gz", "other").path, pkg), /rg not found/);
});

test("installTools installs fd and rg for one platform", { skip: NO_ZIP }, async () => {
	// Both tools pinned to local archives.
	const fdA = archive("fd.tar.gz", "fd");
	const rgA = archive("rg.tar.gz", "rg");
	const saved = { fd: PINS.fd.assets["linux-x64"], rg: PINS.rg.assets["linux-x64"] };
	PINS.fd.assets["linux-x64"] = ["fd.tar.gz", sha256File(fdA.path)];
	PINS.rg.assets["linux-x64"] = ["rg.tar.gz", sha256File(rgA.path)];
	try {
		const fetchFn = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (url.endsWith("fd.tar.gz") ? fdA.bytes : rgA.bytes) });
		const out = await installTools("linux-x64", join(dir, "pkg"), join(dir, "cache"), fetchFn);
		assert.deepEqual(out, [join(dir, "pkg", "bin", "fd"), join(dir, "pkg", "bin", "rg")]);
	} finally {
		PINS.fd.assets["linux-x64"] = saved.fd;
		PINS.rg.assets["linux-x64"] = saved.rg;
	}
});
