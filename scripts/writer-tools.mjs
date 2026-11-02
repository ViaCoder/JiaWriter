// WriterAgent release packages carry pinned copies of fd and ripgrep (the user, 2026-11-01: latest
// releases, SHA256-checked, no download at run time). This script puts the binary of one platform
// into <package>/bin; license texts stay in the repository (the user, 2026-11-02). Archives are cached
// in .tmp/tools-cache and checked against the pinned SHA256 on every use; a mismatch stops the build.
// Usage: node scripts/writer-tools.mjs <platform> <package dir>
//   platform: darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64

// Hashing.
import { createHash } from "node:crypto";
// Files.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
// Temp folder.
import { tmpdir } from "node:os";
// Path helpers.
import { basename, dirname, join } from "node:path";
// tar and unzip.
import { execFileSync } from "node:child_process";
// Entry-point check.
import { fileURLToPath } from "node:url";

/** Pinned releases (versions and digests from the GitHub releases API, 2026-11-01). */
export const PINS = {
	fd: {
		repo: "sharkdp/fd",
		version: "v10.5.0",
		assets: {
			"darwin-arm64": ["fd-v10.5.0-aarch64-apple-darwin.tar.gz", "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12"],
			"darwin-x64": ["fd-v10.5.0-x86_64-apple-darwin.tar.gz", "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590"],
			"linux-x64": ["fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz", "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7"],
			"linux-arm64": ["fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz", "d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4"],
			"windows-x64": ["fd-v10.5.0-x86_64-pc-windows-msvc.zip", "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7"],
			"windows-arm64": ["fd-v10.5.0-aarch64-pc-windows-msvc.zip", "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6"],
		},
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		version: "15.2.0",
		assets: {
			"darwin-arm64": ["ripgrep-15.2.0-aarch64-apple-darwin.tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"],
			"darwin-x64": ["ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1"],
			"linux-x64": ["ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"],
			"linux-arm64": ["ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz", "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915"],
			"windows-x64": ["ripgrep-15.2.0-x86_64-pc-windows-msvc.zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"],
			"windows-arm64": ["ripgrep-15.2.0-aarch64-pc-windows-msvc.zip", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f"],
		},
	},
};

/** SHA256 of a file as hex. */
export function sha256File(path) {
	// Whole file (archives are a few MB).
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Download URL of a pinned asset. */
export function assetUrl(tool, platform) {
	// GitHub release download path.
	const pin = PINS[tool];
	return `https://github.com/${pin.repo}/releases/download/${pin.version}/${pin.assets[platform][0]}`;
}

/** The archive of tool for platform in cacheDir, downloaded when missing; throws on a SHA256 mismatch. */
export async function cachedArchive(tool, platform, cacheDir, fetchFn = fetch) {
	// Pinned name and digest.
	const asset = PINS[tool]?.assets[platform];
	if (!asset) throw new Error(`no pinned ${tool} for ${platform}`);
	const [name, digest] = asset;
	const path = join(cacheDir, name);
	// Download once (one request, no retry).
	if (!existsSync(path)) {
		const res = await fetchFn(assetUrl(tool, platform));
		if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(`${path}.part`, new Uint8Array(await res.arrayBuffer()));
		renameSync(`${path}.part`, path);
	}
	// Checked on every use.
	const actual = sha256File(path);
	if (actual !== digest) {
		rmSync(path, { force: true });
		throw new Error(`${name}: SHA256 ${actual} does not match the pinned ${digest}`);
	}
	return path;
}

/** Files under dir, recursively. */
function walk(dir) {
	// Depth first.
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** Put the binary of tool into <pkgDir>/bin; returns the binary path. */
export function installTool(tool, platform, archive, pkgDir) {
	// Unpack into a fresh temp folder.
	const tmp = mkdtempSync(join(tmpdir(), `wa-${tool}-`));
	try {
		if (archive.endsWith(".zip")) execFileSync("unzip", ["-q", archive, "-d", tmp]);
		else execFileSync("tar", ["-xzf", archive, "-C", tmp]);
		const files = walk(tmp);
		// The executable.
		const exe = tool + (platform.startsWith("windows-") ? ".exe" : "");
		const binary = files.find((f) => basename(f) === exe);
		if (!binary) throw new Error(`${basename(archive)}: ${exe} not found`);
		const target = join(pkgDir, "bin", exe);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(binary, target);
		chmodSync(target, 0o755);
		return target;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Both tools for one platform. */
export async function installTools(platform, pkgDir, cacheDir, fetchFn = fetch) {
	// fd, then rg.
	const out = [];
	for (const tool of ["fd", "rg"]) out.push(installTool(tool, platform, await cachedArchive(tool, platform, cacheDir, fetchFn), pkgDir));
	return out;
}

// Command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Platform and package folder.
	const [platform, pkgDir] = process.argv.slice(2);
	if (!platform || !pkgDir || !PINS.fd.assets[platform]) {
		console.error("usage: node scripts/writer-tools.mjs <platform> <package dir>");
		process.exit(2);
	}
	// Cache next to the repository's other build output.
	const cache = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "tools-cache");
	for (const p of await installTools(platform, pkgDir, cache)) console.log(`  bundled ${basename(p)} (${platform})`);
}
