// JiaWriter real-output evaluation (P2 onward).
// Runs a fixed set of writing tasks through `jiawriter -p` with the user's JW_* variables,
// saves each draft and prints simple, deterministic quality metrics. The key is read only from
// the JW_KEY environment variable by JiaWriter itself; this script never reads or prints it.
// Usage: node scripts/writer-eval.mjs <jiawriter command> <output dir>
//   e.g. node scripts/writer-eval.mjs /path/to/jiawriter ./eval-out

// Run the CLI and wait for it.
import { spawnSync } from "node:child_process";
// Output files.
import { mkdirSync, writeFileSync } from "node:fs";
// Path helpers.
import { join } from "node:path";
// Entry-point check.
import { fileURLToPath } from "node:url";
// Readability check of JiaWriter (TypeScript source, run by Node's type stripping).
import { readabilityCheck } from "../packages/coding-agent/src/writer/readability.ts";
// AI-style check of JiaWriter, the same rules as the style_check tool.
import { styleCheck } from "../packages/coding-agent/src/writer/style/check.ts";
// Character and word counts.
import { countText } from "../packages/coding-agent/src/writer/text-stats.ts";

/** The fixed writing tasks (Chinese prompts, no cited cases until search exists). */
export const TASKS = [
	// Research report.
	{ id: "report", prompt: "写一篇约800字的调研报告，主题是城市社区老年食堂的运营现状与改进建议。这次只写分析和建议，不引用具体案例和数据。直接输出正文。" },
	// Argument essay.
	{ id: "essay", prompt: "写一篇约600字的论述文章，说明中小学为什么要保证学生每天有足够的户外活动时间。不引用具体案例和数据。直接输出正文。" },
	// Work briefing.
	{ id: "brief", prompt: "写一份约500字的工作简报，内容是某区开展垃圾分类督导一个月的情况，数据用“若干”“部分”一类的概括说法。直接输出正文。" },
];

/** CJK ideographs. */
const CJK = /[一-鿿]/;
/** Verification markers that must not appear. */
const MARKERS = /待核实|需核实|\[citation needed\]/gi;

/** Count the matches of one or more regular expressions. */
export function countMatches(text, patterns) {
	// Accept a single pattern or a list.
	const list = Array.isArray(patterns) ? patterns : [patterns];
	// Sum the matches of each pattern.
	return list.reduce((sum, re) => sum + (text.match(new RegExp(re.source, "g"))?.length ?? 0), 0);
}

/** ASCII punctuation directly next to a CJK character (should be full-width). */
export function asciiPunctNearCjk(text) {
	// Count characters , . ; : ! ? ( ) " ' whose neighbour is CJK; skip digits like 3.5.
	let count = 0;
	// Walk the characters.
	for (let i = 0; i < text.length; i++) {
		// Only ASCII punctuation.
		if (!/[,.;:!?()"']/.test(text[i])) continue;
		// A dot between digits is a decimal point.
		if (text[i] === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
		// Neighbour on either side is CJK.
		if (CJK.test(text[i - 1] ?? "") || CJK.test(text[i + 1] ?? "")) count++;
	}
	// Total.
	return count;
}

/** Compute the metrics of one draft with the style_check and readability_check rules. */
export function metrics(text) {
	// AI-style report with the default packs.
	const style = styleCheck(text);
	// Readability report with the default sentence limit.
	const read = readabilityCheck(text);
	// The metrics.
	return {
		// Length.
		cjkChars: countText(text).cjk,
		// Paragraphs (non-empty lines).
		paragraphs: text.split("\n").filter((p) => p.trim()).length,
		// Punctuation problems.
		asciiPunct: asciiPunctNearCjk(text),
		// All style_check pattern hits.
		styleHits: style.hits.length,
		// Contrast frames among them.
		contrast: style.hits.filter((h) => h.zh.startsWith("对比框架")).length,
		// Stock phrases among them.
		cliches: style.hits.filter((h) => h.zh === "套话").length,
		// Negative assertions per 10 sentences.
		negationPer10: style.negation.per10,
		// Verification markers.
		markers: countMatches(text, MARKERS),
		// List lines and bold spans.
		listLines: style.structure.listLines,
		// Bold spans.
		bold: style.structure.bold,
		// Characters outside level 1 of 通用规范汉字表.
		rareChars: read.rare.reduce((sum, r) => sum + r.count, 0),
		// Chinese sentences over the readability_check limit.
		longSentences: read.long.length,
	};
}

/** Run every task with the given command and write drafts plus a summary to outDir. */
export function runEval(command, outDir) {
	// Make the output directory.
	mkdirSync(outDir, { recursive: true });
	// Results per task.
	const rows = [];
	// One CLI run per task.
	for (const task of TASKS) {
		// Start time.
		const started = Date.now();
		// Print mode; JW_* comes from the environment; stdin closed.
		const r = spawnSync(command, ["-p", task.prompt], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
		// The draft text.
		const text = (r.stdout ?? "").trim();
		// Save the draft for review.
		writeFileSync(join(outDir, `${task.id}.md`), `${text}\n`);
		// Keep the metrics.
		rows.push({ task: task.id, exit: r.status, seconds: Math.round((Date.now() - started) / 1000), ...metrics(text) });
	}
	// Save the summary.
	writeFileSync(join(outDir, "metrics.json"), `${JSON.stringify(rows, null, "\t")}\n`);
	// Hand back the rows.
	return rows;
}

// Command-line use.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// Arguments.
	const [command, outDir] = process.argv.slice(2);
	// Both are required.
	if (!command || !outDir) {
		// Usage.
		console.error("usage: node scripts/writer-eval.mjs <jiawriter command> <output dir>");
		// Usage error.
		process.exit(2);
	}
	// Run and print a table.
	console.table(runEval(command, outDir));
}
