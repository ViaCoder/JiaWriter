/**
 * File snapshots for going back in a conversation. Before write or edit changes a file, its bytes are copied
 * to <agentDir>/rewind/<hash of the working folder>/, tagged with the user message being answered. Going back
 * to a message restores each file as it was before that message's first change. Restoring saves the current
 * bytes first, so going back can be undone too.
 */

// Hash of the working folder.
import { createHash } from "node:crypto";
// Files.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
// Paths.
import { dirname, join } from "node:path";

/** One saved state of a file. */
export interface Snapshot {
	// Running number in the store.
	n: number;
	// Absolute path of the file.
	file: string;
	// Saved copy inside the store; null when the file did not exist yet.
	blob: string | null;
	// Session entry of the user message being answered, or RESTORE_TAG.
	user: string;
	// Time taken (ms).
	at: number;
	// Size of the saved copy.
	size: number;
}

/** Tag of a snapshot taken by a restore rather than by a change. */
const RESTORE_TAG = "restore";
/** The list of snapshots. */
const INDEX = "index.jsonl";

/** Store of a working folder: several sessions there see each other's snapshots, and forks keep theirs. */
export function storeDir(agentDir: string, cwd: string): string {
	// The folder's path may hold any character.
	return join(agentDir, "rewind", createHash("sha256").update(cwd).digest("hex").slice(0, 16));
}

/** All snapshots of a store, oldest first. */
export function readSnapshots(store: string): Snapshot[] {
	// A missing store is empty; a line cut off by a crash is skipped.
	const file = join(store, INDEX);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf-8")
		.split("\n")
		.flatMap((line) => {
			try {
				return line.trim() ? [JSON.parse(line) as Snapshot] : [];
			} catch {
				return [];
			}
		});
}

/** Save a file's current state for a user message, once per message and file. */
export function takeSnapshot(store: string, file: string, user: string, now = Date.now()): Snapshot | undefined {
	// Later changes in the same answer are covered by the first snapshot.
	const all = readSnapshots(store);
	if (user !== RESTORE_TAG && all.some((s) => s.file === file && s.user === user)) return undefined;
	// The next number, and the bytes when the file exists.
	const n = all.reduce((most, s) => Math.max(most, s.n), 0) + 1;
	const exists = existsSync(file);
	const blob = exists ? `${n}.bak` : null;
	mkdirSync(store, { recursive: true });
	if (blob) copyFileSync(file, join(store, blob));
	const snapshot: Snapshot = { n, file, blob, user, at: now, size: exists ? statSync(file).size : 0 };
	appendFileSync(join(store, INDEX), `${JSON.stringify(snapshot)}\n`);
	return snapshot;
}

/** For going back past the given user messages: each file's earliest snapshot among them. */
export function undoTargets(snapshots: readonly Snapshot[], users: ReadonlySet<string>): Snapshot[] {
	// Oldest first, so the first one seen per file wins.
	const byFile = new Map<string, Snapshot>();
	for (const s of snapshots) if (users.has(s.user) && !byFile.has(s.file)) byFile.set(s.file, s);
	return [...byFile.values()];
}

/** Bring a file back to a snapshot, saving what is there now first. */
export function restoreSnapshot(store: string, snapshot: Snapshot, now = Date.now()): void {
	// Going back can itself be undone.
	takeSnapshot(store, snapshot.file, RESTORE_TAG, now);
	// A file that did not exist goes away again.
	if (snapshot.blob === null) {
		rmSync(snapshot.file, { force: true });
		return;
	}
	mkdirSync(dirname(snapshot.file), { recursive: true });
	copyFileSync(join(store, snapshot.blob), snapshot.file);
}

/** The saved states of one file that hold content, oldest first. */
export function versionsOf(snapshots: readonly Snapshot[], file: string): Snapshot[] {
	// A "did not exist" state is no version of the text.
	return snapshots.filter((s) => s.file === file && s.blob !== null);
}
