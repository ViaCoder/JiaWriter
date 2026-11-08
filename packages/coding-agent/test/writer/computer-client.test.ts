// The driver's stdio client (src/writer/computer/client.ts), against a process made of streams.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { connectDriver, driverReply, startDriver, stopReason } from "../../src/writer/computer/client.ts";

/** A driver that answers every request. */
function fakeProcess(answer: (method: string, params: { name?: string }) => unknown) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const events = new EventEmitter();
	let killed = false;
	stdin.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n").filter(Boolean)) {
			const m = JSON.parse(line) as { id?: number; method: string; params: { name?: string } };
			if (m.id !== undefined)
				stdout.write(`noise\n${JSON.stringify({ id: m.id, ...(answer(m.method, m.params) as object) })}\n`);
		}
	});
	return {
		stdin,
		stdout,
		stderr,
		on: (event: "exit" | "error", listener: () => void) => events.on(event, listener),
		kill: () => {
			killed = true;
		},
		stop: () => events.emit("exit"),
		wasKilled: () => killed,
	};
}

describe("driverReply", () => {
	it("splits words, structure and a picture", () => {
		const reply = driverReply({
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "UElD" },
				{ type: "text", text: "b" },
			],
			structuredContent: { x: 1 },
			isError: true,
		});
		expect(reply).toEqual({
			structured: { x: 1 },
			text: "a\nb",
			failed: true,
			image: { data: "UElD", mimeType: "image/png" },
		});
		expect(driverReply({})).toEqual({ structured: {}, text: "", failed: false });
	});
});

describe("connectDriver", () => {
	it("greets, calls and ignores lines that are not the protocol", async () => {
		const child = fakeProcess((method, params) => ({
			result: method === "tools/call" ? { content: [{ type: "text", text: `ran ${params.name}` }] } : {},
		}));
		const client = await connectDriver(child);
		expect((await client.call("list_windows", {})).text).toBe("ran list_windows");
		client.close();
		expect(child.wasKilled()).toBe(true);
	});

	it("passes a protocol error on", async () => {
		const child = fakeProcess((method) => (method === "tools/call" ? { error: { message: "no" } } : { result: {} }));
		const client = await connectDriver(child);
		await expect(client.call("x", {})).rejects.toThrow("no");
	});

	it("does not hang on a driver that went away", async () => {
		const child = fakeProcess((method) => (method === "initialize" ? { result: {} } : undefined));
		const silent = fakeProcess(() => ({ result: {} }));
		const client = await connectDriver(silent);
		silent.stdin.removeAllListeners("data");
		const pending = client.call("x", {});
		silent.stop();
		await expect(pending).rejects.toThrow("driver stopped");
		expect(child).toBeDefined();
	});

	it("says why the driver stopped, from its last line of errors", async () => {
		const child = fakeProcess(() => ({ result: {} }));
		const client = await connectDriver(child);
		child.stdin.removeAllListeners("data");
		const pending = client.call("x", {});
		child.stderr.write("starting\ndaemon did not appear\n");
		// The line is read before the process is gone.
		await new Promise((done) => setTimeout(done, 20));
		child.stop();
		await expect(pending).rejects.toThrow("driver stopped: daemon did not appear");
	});
});

describe("stopReason", () => {
	it("gives the driver's last complaint, with the home directory as ~", () => {
		expect(stopReason("", "/Users/u")).toBe("driver stopped");
		expect(stopReason("no daemon on /Users/u/Library/x.sock", "/Users/u")).toBe(
			"driver stopped: no daemon on ~/Library/x.sock",
		);
		expect(stopReason("x".repeat(500), "").length).toBeLessThan(330);
	});
});

describe("startDriver", () => {
	it("fails rather than hangs on a program that is not there", async () => {
		const started = performance.now();
		await expect(startDriver("/no/such/program", {})).rejects.toThrow("driver stopped");
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
