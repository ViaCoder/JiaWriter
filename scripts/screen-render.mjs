// What a terminal really shows after a stream of output: the bytes a program wrote, played through a headless
// xterm, and the visible screen printed line by line. The checks that drive JiaWriter in a pseudo-terminal use it
// to judge the screen itself rather than the raw stream, where every past frame is still present.
// Usage: node scripts/screen-render.mjs <raw output file> <columns> <rows>

// The raw bytes.
import { readFileSync } from "node:fs";
// Loading the emulator from where it is installed.
import { createRequire } from "node:module";
import { join } from "node:path";

// The terminal emulator the interface's own tests use: from the repository, or from JW_SCREEN_MODULES where a CI job
// that installs nothing else puts that one package.
const from = process.env.JW_SCREEN_MODULES ? join(process.env.JW_SCREEN_MODULES, "index.js") : import.meta.url;
const xterm = createRequire(from)("@xterm/headless");

// Arguments: the file, then the terminal's size.
const [file, columns, rows] = process.argv.slice(2);
// A terminal of that size; nobody types into it.
const term = new xterm.Terminal({ cols: Number(columns), rows: Number(rows), allowProposedApi: true, disableStdin: true });
// Writing is asynchronous: the screen is read once everything has been drawn.
term.write(readFileSync(file), () => {
	// The buffer shown now: the alternate screen in fullscreen mode, else the normal one.
	const buffer = term.buffer.active;
	const lines = [];
	// With JW_SCREEN_BG set, also the rows whose cells mostly carry a background colour (a message band, a selection).
	const banded = [];
	for (let i = 0; i < term.rows; i++) {
		const line = buffer.getLine(buffer.viewportY + i);
		lines.push(line?.translateToString(true) ?? "");
		if (!process.env.JW_SCREEN_BG || !line) continue;
		let coloured = 0;
		for (let x = 0; x < term.cols; x++) if (!line.getCell(x)?.isBgDefault()) coloured++;
		if (coloured > term.cols / 2) banded.push(i);
	}
	// Which buffer it is, then the lines.
	process.stdout.write(`${JSON.stringify({ buffer: buffer.type, lines, ...(process.env.JW_SCREEN_BG ? { banded } : {}) })}\n`);
});
