/**
 * The JiaWriter name in text users see. The source tree keeps the upstream name "pi" so upstream tests
 * stay unchanged; a release package carries piConfig.name "jiawriter" and title "JiaWriter"
 * (scripts/writer-brand.mjs), and then every "pi" / "Pi" shown to the user reads "JiaWriter".
 */

// The command name and the display name from package.json.
import { APP_NAME, APP_TITLE } from "../config.ts";

/** "pi" or "Pi" as a word: not part of a package name, path, file name or identifier (pi-coding-agent, .pi/, pi.dev). */
const PI_WORD = /(?<![\w@/.-])[Pp]i(?![\w\-/]|\.\w)/g;

/** Text with the product name shown to the user; unchanged in the source tree (name "pi"). */
export function brandText(text: string, name: string = APP_NAME, title: string = APP_TITLE): string {
	// Source checkout: the upstream name stays.
	if (name === "pi") return text;
	// Lines that point at pi.dev belong to removed features (share viewer, installer): left out.
	const lines = text.split("\n").filter((line) => !line.includes("pi.dev"));
	// The self-update alias "pi" does not exist under another name.
	const kept = lines.join("\n").replace(/\|self\|pi\]/g, "|self]");
	// Every remaining "pi" word becomes the display name.
	return kept.replace(PI_WORD, title);
}
