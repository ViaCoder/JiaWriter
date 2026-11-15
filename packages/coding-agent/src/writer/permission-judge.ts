/**
 * The judge of auto mode (the user, 2026-11-15: "can make it similar claude code which decide by model?"). In auto
 * mode an ordinary action (a write inside the working folder, a command that changes something there) is first put
 * to the session's model in a request of its own, with the user's latest words and the action: plainly part of
 * carrying out the request and unable to lose the user's work means ALLOW, anything else means ASK, and ASK or any
 * failure of the judge puts the question to the user as before. Reading never asks; high risk always asks the user;
 * the rules of permission.ts stay the floor the judge cannot lower. JW_PERMISSION_JUDGE=off keeps the rules alone.
 */

// Session entries, for the user's latest words.
import type { SessionEntry } from "../core/session-manager.ts";
// The request the gate judges.
import type { PermissionRequest } from "./permission.ts";

/** What the judge answers. */
export type Verdict = "allow" | "ask";
/** A judge: the action and the user's latest words in, a verdict out. */
export type Judge = (request: PermissionRequest, lastRequest: string, created?: readonly string[]) => Promise<Verdict>;

/** Reasoning tokens the judge may use: a one-word answer. */
export const JUDGE_REASONING_TOKENS = 512;
/** Longest wait for a verdict: past it the user is asked. */
export const JUDGE_TIMEOUT_MS = 20_000;

/** Whether the judge runs (JW_PERMISSION_JUDGE=off or rules turns it off). */
export function judgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.JW_PERMISSION_JUDGE ?? "").trim().toLowerCase();
	return v !== "off" && v !== "rules" && v !== "0" && v !== "false";
}

/** The judge's instructions. */
export const JUDGE_INSTRUCTIONS = `You are the permission judge of a writing assistant that works in the user's folder. You see the user's latest request and one action the assistant is about to take (a shell command, or a file it will write or edit). Decide whether the action may go ahead without asking the user.

Answer ALLOW only when both hold:
- The action is plainly a step of carrying out the latest request (or of the work the request continues), not something the user did not ask for.
- It cannot lose the user's work: it creates or changes the assistant's own output files (drafts, exports, notes, generated files), changes a file of the user's in exactly the way the request asks, runs a script the assistant itself wrote for the request, or runs a command whose effects stay inside the folder and are easy to undo.

Answer ASK when the action deletes, overwrites or moves files the user made beyond what the request asks, changes files unrelated to the request, installs software, changes system or account settings, sends anything out of the machine, or when you are unsure.

Reply with one word: ALLOW or ASK.`;

/** The text put to the judge. */
export function judgeText(
	request: PermissionRequest,
	lastRequest: string,
	cwd: string,
	created: readonly string[] = [],
): string {
	const kind = request.scope.startsWith("shell") ? "Shell command" : "File to write or edit";
	// The files the assistant made this session, so a script it wrote is known as its own.
	const made =
		created.length > 0 ? `\n\nFiles the assistant created or changed in this session:\n${created.join("\n")}` : "";
	return `Working folder: ${cwd}\n\nUser's latest request:\n${lastRequest.trim() || "(none recorded)"}${made}\n\n${kind}:\n${request.detail}`;
}

/** The verdict in a reply: ALLOW as its first word, else ask. */
export function parseVerdict(reply: string): Verdict {
	return /^\W*allow\b/i.test(reply.trim()) ? "allow" : "ask";
}

/** The user's latest words on the branch: the text of the last user message, cut to a page. */
export function lastUserText(branch: readonly SessionEntry[]): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		return text.trim().slice(0, 2000);
	}
	return "";
}

/** A judge over one way of asking the model (modelAsker); failures and timeouts mean ask. */
export function makeJudge(ask: (instructions: string, text: string) => Promise<string>, cwd: string): Judge {
	return async (request, lastRequest, created) => {
		try {
			return parseVerdict(await ask(JUDGE_INSTRUCTIONS, judgeText(request, lastRequest, cwd, created)));
		} catch {
			return "ask";
		}
	};
}
