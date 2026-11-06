/**
 * A record of what an upstream search request really did, so a failed one can be explained afterwards.
 * It works at the HTTP level: what was sent, what came back, and every kind of stream event, also when
 * an SDK gives up on the stream. Every line passes through cleanLog before it leaves, header values
 * are never recorded, and a failure here never touches the request.
 */

// The headers and the fetch type.
import type { FetchFunction, ProviderHeaders } from "../types.ts";

/** Takes one finished line. */
export type ServerLogWrite = (line: string) => void;

/** Takes one entry; the fields are cleaned and turned into a line. */
export type ServerLog = (entry: Record<string, unknown>) => void;

/** Longest request or response body kept. */
const BODY_LIMIT = 4000;
/** Longest sample of one kind of event. */
const SAMPLE_LIMIT = 1500;
/** Shortest value treated as a secret: a shorter one would cut up ordinary words. */
const SHORTEST_SECRET = 6;
/** Response headers that help and hold nothing private. */
const SHOWN_HEADERS = [
	"content-type",
	"x-request-id",
	"request-id",
	"cf-ray",
	"server",
	"via",
	"retry-after",
	"x-should-retry",
];
/** Secrets by their form, for one an upstream echoes back in another shape. */
const SECRET_FORMS = [
	// Header and field pairs, also inside escaped JSON.
	/[\\"]*(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|set-cookie|cookie|api[_-]?key|access[_-]?token)[\\"]*\s*[:=]\s*[\\"]*(?:bearer\s+|basic\s+)?[^\s\\"',;]+/gi,
	// Bearer and Basic values alone.
	/\bbearer\s+[^\s\\"',;]{8,}/gi,
	/\bbasic\s+[A-Za-z0-9+/=]{12,}/gi,
	// Provider keys.
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
	// Login tokens.
	/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/g,
];

/** The values that must never reach a log: the key and the configured header values. */
export function secretsOf(key: string | undefined, ...headers: (ProviderHeaders | undefined)[]): string[] {
	// Every header value, whatever its name.
	const values = headers.flatMap((set) => Object.values(set ?? {}));
	// Only real values, long enough to be safe to cut out.
	return [key, ...values].filter((v): v is string => typeof v === "string" && v.length >= SHORTEST_SECRET);
}

/** Text with every secret taken out, by value and by form. */
export function cleanLog(text: string, secrets: readonly string[]): string {
	// The known values first, in full.
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("<redacted>");
	// Then whatever has the form of one.
	for (const form of SECRET_FORMS) out = out.replace(form, "<redacted>");
	return out;
}

/** An address without its login, query or fragment, which can hold tokens. */
export function safeUrl(url: string): string {
	try {
		// Parsed, so the parts are exact.
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		// Not an address: nothing from it is kept.
		return "<bad url>";
	}
}

/** The start of a text, saying how much was left out. */
function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length} chars]`;
}

/** A logger that stamps, cleans and writes each entry; a failed write is dropped. */
export function serverLog(write: ServerLogWrite, secrets: readonly string[]): ServerLog {
	return (entry) => {
		try {
			// One point of cleaning: nothing reaches the line another way.
			write(cleanLog(JSON.stringify({ time: new Date().toISOString(), ...entry }), secrets));
		} catch {
			// The log is never a reason for a search to fail.
		}
	};
}

/** A stream event's name with its kind, such as content_block_start:server_tool_use. */
export function eventName(data: Record<string, unknown>, fallback: string): string {
	// The event's own type, else the SSE event line.
	const type = typeof data.type === "string" ? data.type : fallback;
	// The object that says what happened inside it.
	const inner = (data.item ?? data.content_block ?? data.delta) as { type?: unknown } | undefined;
	// With the kind when there is one.
	return typeof inner?.type === "string" ? `${type}:${inner.type}` : type;
}

/** Everything about one stream line worth counting. */
function lineName(payload: string, fallback: string): string {
	// The stream's own end.
	if (payload === "[DONE]") return "[DONE]";
	try {
		// A JSON event.
		const data = JSON.parse(payload) as unknown;
		return data && typeof data === "object" ? eventName(data as Record<string, unknown>, fallback) : "not-an-object";
	} catch {
		// A line that is no event at all.
		return "unparsed";
	}
}

/** Read a copy of a stream: one sample per kind of event, the counts, the last event and how it ended. */
async function traceStream(reply: Response, log: ServerLog, started: number): Promise<void> {
	// Kinds in order of first arrival.
	const counts = new Map<string, number>();
	// The last data line.
	let last = "";
	// The SSE event line before the data.
	let named = "";
	// Bytes of a line still arriving.
	let held = "";
	/** Count one stream line. */
	const take = (raw: string) => {
		// Lines end in \n or \r\n.
		const line = raw.trimEnd();
		if (line.startsWith("event:")) named = line.slice(6).trim();
		if (!line.startsWith("data:")) return;
		// The event.
		const payload = line.slice(5).trim();
		const name = lineName(payload, named);
		const seen = counts.get(name) ?? 0;
		counts.set(name, seen + 1);
		last = payload;
		// The first of each kind shows what it looks like.
		if (seen === 0) log({ kind: "event", name, sample: clip(payload, SAMPLE_LIMIT) });
	};
	// How the stream ended.
	let ended = "closed";
	try {
		// Bytes split anywhere, even inside a character.
		const decoder = new TextDecoder();
		for await (const chunk of reply.body as unknown as AsyncIterable<Uint8Array>) {
			held += decoder.decode(chunk, { stream: true });
			const lines = held.split("\n");
			held = lines.pop() ?? "";
			lines.forEach(take);
		}
		take(held);
	} catch (error) {
		// Cut off on the way: this is often the answer.
		ended = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}
	// What arrived, in order, and where it stopped.
	log({
		kind: "stream",
		ms: Date.now() - started,
		ended,
		counts: Object.fromEntries(counts),
		last: clip(last, BODY_LIMIT),
	});
}

/** Read a copy of a reply that is no stream: an error, or a relay answering in another form. */
async function traceBody(reply: Response, log: ServerLog): Promise<void> {
	log({ kind: "body", status: reply.status, text: clip(await reply.text(), BODY_LIMIT) });
}

/** The fields of a request worth keeping. */
function requestEntry(input: Parameters<FetchFunction>[0], init: RequestInit | undefined): Record<string, unknown> {
	// The address in any of its forms.
	const url = input instanceof Request ? input.url : String(input);
	// Header names show the form of the request; their values stay out.
	const headers = [...new Headers(init?.headers).keys()];
	// The JSON the SDK built, which holds no key.
	const body = typeof init?.body === "string" ? clip(init.body, BODY_LIMIT) : "";
	return { kind: "request", method: init?.method ?? "GET", url: safeUrl(url), headers, body };
}

/** A fetch that records each exchange and hands the reply on untouched. */
export function tracedFetch(log: ServerLog, send: FetchFunction = fetch): FetchFunction {
	return (async (input: Parameters<FetchFunction>[0], init?: RequestInit) => {
		// For the time each step took.
		const started = Date.now();
		log(requestEntry(input, init));
		try {
			const reply = await send(input, init);
			// Only headers known to be harmless.
			const headers = Object.fromEntries(
				SHOWN_HEADERS.flatMap((n) => [[n, reply.headers.get(n)]]).filter((h) => h[1]),
			);
			log({ kind: "response", status: reply.status, ms: Date.now() - started, headers });
			// A copy, so the caller reads the reply as if nothing were here.
			const copy = reply.clone();
			// The record is read on the side, and its failures stay there.
			const stream = reply.headers.get("content-type")?.includes("text/event-stream");
			void (stream ? traceStream(copy, log, started) : traceBody(copy, log)).catch(() => undefined);
			return reply;
		} catch (error) {
			// No reply at all: the cause holds the system's reason.
			const cause =
				error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
			log({
				kind: "network",
				ms: Date.now() - started,
				name: error instanceof Error ? error.name : "unknown",
				message: error instanceof Error ? error.message : String(error),
				code: cause?.code,
				cause: cause?.message,
			});
			throw error;
		}
	}) as FetchFunction;
}

/** The entry for a failed call: enough to tell who gave up, and why. */
export function failureEntry(error: unknown, ms: number): Record<string, unknown> {
	// An SDK error has a status; a named failure has a code.
	const fields = (error ?? {}) as { status?: unknown; code?: unknown; stack?: unknown };
	return {
		kind: "failed",
		ms,
		name: error instanceof Error ? error.constructor.name : typeof error,
		status: fields.status,
		code: fields.code,
		message: error instanceof Error ? error.message : String(error),
		stack: typeof fields.stack === "string" ? clip(fields.stack, 800) : undefined,
	};
}
