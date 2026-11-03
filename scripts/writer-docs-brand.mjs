// JiaWriter: the upstream docs shipped in a release package (docs/, read by the model when the user asks
// about the program) name the product "pi". This script rewrites them for the package so users see
// JiaWriter: in code (fenced blocks and inline code) the command and its folders become jiawriter and
// ~/.jiawriter/, in prose the name becomes JiaWriter. Package names (@earendil-works/pi-…), URLs,
// identifiers such as pi.registerTool and PI_* variables stay as they are.
// Usage: node scripts/writer-docs-brand.mjs <docs folder>   (rewrites every .md file in place)

// Files.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
// Paths.
import { join } from "node:path";
// Entry-point check.
import { fileURLToPath } from "node:url";

// The command name and the display name.
const COMMAND = "jiawriter";
const TITLE = "JiaWriter";

/** Folder names: ~/.pi/ and .pi/ (project folder) become ~/.jiawriter/ and .jiawriter/. */
function folders(text) {
	// The dot folder, not part of another name.
	return text.replace(/(?<![\w-])\.pi(?=\/|\b(?![\w.-]))/g, `.${COMMAND}`);
}

/** Code: folders, and the command word where a shell command starts (pi install …, $ pi, | pi). */
export function brandCode(code) {
	// "pi" as a whole command word; "pi.", "pi:", "pi(" and "pi-…" are code and stay.
	return folders(code).replace(/(^|[\s$|&;(`])pi(?=\s|$)/gm, `$1${COMMAND}`);
}

/** Prose: folders, then "pi" / "Pi" as a word becomes the display name. */
export function brandProse(text) {
	// Same word rule as src/writer/brand.ts.
	return folders(text).replace(/(?<![\w@/.\-])[Pp]i(?![\w\-/]|\.\w)/g, TITLE);
}

/** One Markdown file: fenced blocks and inline code get brandCode, the rest brandProse. */
export function brandMarkdown(md) {
	// Output pieces and fence state.
	const out = [];
	let fence = "";
	for (const line of md.split("\n")) {
		// A fence opens or closes (``` or ~~~, three or more).
		const m = /^\s*(`{3,}|~{3,})/.exec(line);
		if (m && (!fence || m[1][0] === fence[0])) {
			fence = fence ? "" : m[1];
			out.push(line);
			continue;
		}
		// Inside a fenced block: code.
		if (fence) {
			out.push(brandCode(line));
			continue;
		}
		// Outside: inline code spans are code, the text between them prose.
		out.push(
			line
				.split(/(`[^`]*`)/)
				.map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? brandCode(part) : brandProse(part)))
				.join(""),
		);
	}
	return out.join("\n");
}

/** Every .md file under dir, rewritten in place; returns how many changed. */
export function brandDocs(dir) {
	// Walk the folder.
	let changed = 0;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) changed += brandDocs(p);
		else if (name.endsWith(".md")) {
			const before = readFileSync(p, "utf-8");
			const after = brandMarkdown(before);
			if (after !== before) {
				writeFileSync(p, after);
				changed += 1;
			}
		}
	}
	return changed;
}

// Command line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// One folder.
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: node scripts/writer-docs-brand.mjs <docs folder>");
		process.exit(2);
	}
	console.log(`branded ${brandDocs(dir)} files in ${dir}`);
}
