// WriterAgent real-output evaluation (P2 onward).
// Runs a fixed set of writing tasks through `writeragent -p` with the user's WA_* variables,
// saves each draft and prints simple, deterministic quality metrics. The key is read only from
// the WA_KEY environment variable by WriterAgent itself; this script never reads or prints it.
// Usage: node scripts/writer-eval.mjs <writeragent command> <output dir>
//   e.g. node scripts/writer-eval.mjs /path/to/writeragent ./eval-out

// Run the CLI and wait for it.
import { spawnSync } from "node:child_process";
// Output files.
import { mkdirSync, writeFileSync } from "node:fs";
// Path helpers.
import { join } from "node:path";
// Entry-point check.
import { fileURLToPath } from "node:url";

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
/** Contrast frames (6b). */
const CONTRAST = [/不是[^。！？\n]{0,40}?而是/g, /(?:并非|不在于)[^。！？\n]{0,30}?而(?:是|在于)/g, /与其说[^。！？\n]{0,30}?不如说/g, /不(?:仅|只)[^。！？\n]{0,30}?更(?:是|要)/g];
/** Negative assertions (6b); prohibitions such as 不得/严禁/禁止 are not counted. */
const NEGATIVE = /并不意味着|不意味着|不代表|不等于|不足以|无法|难以|不能|未能|并不|并非/g;
/** Common stock phrases. */
const CLICHES = /综上所述|总而言之|总的来说|值得注意的是|值得一提的是|毋庸置疑|不难发现|由此可见|让我们|众所周知/g;
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

/** Compute the metrics of one draft. */
export function metrics(text) {
	// Sentences end with Chinese or ASCII terminal punctuation.
	const sentences = Math.max(1, text.split(/[。！？!?]+/).filter((s) => s.trim()).length);
	// Lines that look like list items or markdown headings.
	const structured = text.split("\n").filter((l) => /^\s*([-*•]|\d+[.、)]|#{1,6}\s)/.test(l)).length;
	// The metrics.
	return {
		// Length.
		cjkChars: [...text].filter((c) => CJK.test(c)).length,
		// Paragraphs (non-empty blocks).
		paragraphs: text.split(/\n\s*\n|\n/).filter((p) => p.trim()).length,
		// Punctuation problems.
		asciiPunct: asciiPunctNearCjk(text),
		// Contrast frames.
		contrast: countMatches(text, CONTRAST),
		// Negative assertions per 10 sentences, one decimal.
		negationPer10: Math.round((countMatches(text, NEGATIVE) / sentences) * 100) / 10,
		// Stock phrases.
		cliches: countMatches(text, CLICHES),
		// Verification markers.
		markers: countMatches(text, MARKERS),
		// List items and headings.
		structuredLines: structured,
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
		// Print mode; WA_* comes from the environment; stdin closed.
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
		console.error("usage: node scripts/writer-eval.mjs <writeragent command> <output dir>");
		// Usage error.
		process.exit(2);
	}
	// Run and print a table.
	console.table(runEval(command, outDir));
}
