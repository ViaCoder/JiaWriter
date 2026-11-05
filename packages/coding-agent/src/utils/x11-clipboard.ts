/**
 * Clipboard writes on X11 with no helper program: a fresh Ubuntu desktop has no xclip, xsel or wl-copy, and its
 * terminal does not take OSC 52, so a selection copied there went nowhere.
 *
 * On X11 the clipboard is not a store: a program owns the selection and hands the text to whoever pastes. So this
 * speaks just enough of the X protocol to be that owner, inside the running program. The text can be pasted while
 * the program runs; it goes when the program ends, as with any owner.
 */

// Reading the X authority file.
import { readFileSync } from "node:fs";
// Connecting to the X server.
import { connect, type Socket } from "node:net";
// Default place of the X authority file.
import { homedir } from "node:os";
// Paths.
import { join } from "node:path";

// Request numbers of the X protocol.
const CREATE_WINDOW = 1;
const INTERN_ATOM = 16;
const CHANGE_PROPERTY = 18;
const SET_SELECTION_OWNER = 22;
const GET_SELECTION_OWNER = 23;
const SEND_EVENT = 25;
// Event numbers.
const SELECTION_REQUEST = 30;
const SELECTION_NOTIFY = 31;
// Atoms every server predefines.
const ATOM_PRIMARY = 1;
const ATOM_ATOM = 4;
const ATOM_STRING = 31;
// InputOnly window class: a window nobody sees.
const INPUT_ONLY = 2;
// The authority entry for connections on this machine, and the one for any address.
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
// The only authentication method used.
const COOKIE_NAME = "MIT-MAGIC-COOKIE-1";
// How long a connection or a request may take (ms).
const TIMEOUT_MS = 2000;
// Size of a ChangeProperty request without its data.
const PROPERTY_HEADER = 24;

/** A connection that owns, or can own, the selections. */
interface Owner {
	// The connection.
	socket: Socket;
	// The window that stands for this program.
	window: number;
	// Longest text one request can carry (bytes).
	maxBytes: number;
	// CLIPBOARD, the selection Ctrl+V reads.
	clipboard: number;
	// Text being offered.
	text: Buffer;
	// Sends a request whose reply matters, resolves with the reply.
	ask: (request: Buffer) => Promise<Buffer>;
}

/** The display number of a local DISPLAY value (":0", ":1.0", "unix:0"); undefined for a remote one. */
export function displayNumber(display: string | undefined): number | undefined {
	const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display ?? "");
	return match ? Number(match[1]) : undefined;
}

/** The cookie for a display in an X authority file, or undefined when there is none. */
export function findCookie(file: Buffer, display: number): Buffer | undefined {
	// Records of big-endian length-prefixed fields.
	let at = 0;
	const field = (): Buffer => {
		const length = file.readUInt16BE(at);
		const value = file.subarray(at + 2, at + 2 + length);
		at += 2 + length;
		return value;
	};
	while (at + 2 <= file.length) {
		const family = file.readUInt16BE(at);
		at += 2;
		field();
		const number = field().toString();
		const name = field().toString();
		const data = field();
		const local = family === FAMILY_LOCAL || family === FAMILY_WILD;
		if (local && name === COOKIE_NAME && (number === "" || number === String(display))) return data;
	}
	return undefined;
}

/** Bytes up to the next multiple of four, which every X message keeps to. */
function padded(data: Buffer): Buffer {
	return Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
}

/** The first message on a connection, little-endian, with the cookie when there is one. */
export function setupRequest(cookie: Buffer | undefined): Buffer {
	const head = Buffer.alloc(12);
	// Byte order, then protocol 11.0.
	head.write("l", 0);
	head.writeUInt16LE(11, 2);
	if (cookie) {
		head.writeUInt16LE(COOKIE_NAME.length, 6);
		head.writeUInt16LE(cookie.length, 8);
	}
	return cookie ? Buffer.concat([head, padded(Buffer.from(COOKIE_NAME)), padded(cookie)]) : head;
}

/** What a setup reply gives: where new ids start, the root window and the longest request; undefined on refusal. */
export function parseSetup(reply: Buffer): { idBase: number; root: number; maxBytes: number } | undefined {
	// Status 1 is success.
	if (reply[0] !== 1) return undefined;
	const vendor = reply.readUInt16LE(24);
	const formats = reply[29] ?? 0;
	// The first screen follows the vendor name and the pixmap formats.
	const screen = 40 + vendor + ((4 - (vendor % 4)) % 4) + formats * 8;
	return {
		idBase: reply.readUInt32LE(12),
		root: reply.readUInt32LE(screen),
		maxBytes: reply.readUInt16LE(26) * 4 - PROPERTY_HEADER,
	};
}

/** A request with its number and length filled in. */
function request(code: number, detail: number, body: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head[0] = code;
	head[1] = detail;
	const data = padded(body);
	head.writeUInt16LE((data.length + 4) / 4, 2);
	return Buffer.concat([head, data]);
}

/** A body of 32-bit values. */
function words(...values: number[]): Buffer {
	const body = Buffer.alloc(values.length * 4);
	values.forEach((v, i) => {
		body.writeUInt32LE(v, i * 4);
	});
	return body;
}

/** The InternAtom request for a name. */
function internAtom(name: string): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt16LE(name.length, 0);
	return request(INTERN_ATOM, 0, Buffer.concat([head, Buffer.from(name)]));
}

/** The ChangeProperty request that puts data on a window. */
function changeProperty(window: number, property: number, type: number, format: 8 | 32, data: Buffer): Buffer {
	const body = Buffer.concat([
		words(window, property, type),
		Buffer.from([format, 0, 0, 0]),
		words(data.length / (format / 8)),
		data,
	]);
	return request(CHANGE_PROPERTY, 0, body);
}

/** The SendEvent request that tells a program its text is ready; property 0 means refused. */
function selectionNotify(event: Buffer, property: number): Buffer {
	const reply = Buffer.alloc(32);
	reply[0] = SELECTION_NOTIFY;
	// Time, requestor, selection and target, as they came.
	reply.writeUInt32LE(event.readUInt32LE(4), 4);
	reply.writeUInt32LE(event.readUInt32LE(12), 8);
	reply.writeUInt32LE(event.readUInt32LE(16), 12);
	reply.writeUInt32LE(event.readUInt32LE(20), 16);
	reply.writeUInt32LE(property, 20);
	return request(SEND_EVENT, 0, Buffer.concat([words(event.readUInt32LE(12), 0), reply]));
}

/** Answer a program that pastes: the kinds on offer, or the text. */
function answerPaste(owner: Owner, event: Buffer, utf8: number, targets: number, text: number): void {
	const requestor = event.readUInt32LE(12);
	const target = event.readUInt32LE(20);
	// Older programs leave the property out and mean the target itself.
	const property = event.readUInt32LE(24) || target;
	if (target === targets) {
		owner.socket.write(changeProperty(requestor, property, ATOM_ATOM, 32, words(targets, utf8, ATOM_STRING, text)));
		owner.socket.write(selectionNotify(event, property));
	} else if (target === utf8 || target === ATOM_STRING || target === text) {
		owner.socket.write(changeProperty(requestor, property, target, 8, owner.text));
		owner.socket.write(selectionNotify(event, property));
	} else {
		owner.socket.write(selectionNotify(event, 0));
	}
}

/** Connect, set up, and make the window that will own the selections. */
function openOwner(display: number, env: NodeJS.ProcessEnv): Promise<Owner | undefined> {
	return new Promise((resolve) => {
		const socket = connect(`/tmp/.X11-unix/X${display}`);
		// Bytes not yet read, replies still awaited, and what happens to a finished message.
		let incoming = Buffer.alloc(0);
		const waiting: Array<(reply: Buffer) => void> = [];
		let connected = false;
		let owner: Owner | undefined;
		let atoms: { utf8: number; targets: number; text: number } | undefined;
		const fail = () => {
			socket.destroy();
			resolve(undefined);
		};
		const timer = setTimeout(fail, TIMEOUT_MS);
		const ask = (message: Buffer) =>
			new Promise<Buffer>((answer) => {
				waiting.push(answer);
				socket.write(message);
			});
		// Set up the connection, then read messages of 32 bytes, a reply being longer by its length field.
		const read = () => {
			while (incoming.length >= 8) {
				if (!connected) {
					const size = 8 + incoming.readUInt16LE(6) * 4;
					if (incoming.length < size) return;
					const reply = incoming.subarray(0, size);
					incoming = incoming.subarray(size);
					const setup = parseSetup(reply);
					if (!setup) return fail();
					connected = true;
					void start(setup);
					continue;
				}
				if (incoming.length < 32) return;
				const size = incoming[0] === 1 ? 32 + incoming.readUInt32LE(4) * 4 : 32;
				if (incoming.length < size) return;
				const message = incoming.subarray(0, size);
				incoming = incoming.subarray(size);
				const kind = (message[0] ?? 0) & 0x7f;
				if (kind === 1) waiting.shift()?.(message);
				// An error: nothing here can go on from it.
				else if (kind === 0) fail();
				else if (kind === SELECTION_REQUEST && owner && atoms) {
					answerPaste(owner, message, atoms.utf8, atoms.targets, atoms.text);
				}
			}
		};
		// Names for the kinds of text, then the window.
		const start = async (setup: { idBase: number; root: number; maxBytes: number }) => {
			const atom = async (name: string) => (await ask(internAtom(name))).readUInt32LE(8);
			const clipboard = await atom("CLIPBOARD");
			const found = { utf8: await atom("UTF8_STRING"), targets: await atom("TARGETS"), text: await atom("TEXT") };
			const window = setup.idBase | 1;
			const geometry = Buffer.alloc(16);
			geometry.writeUInt16LE(1, 4);
			geometry.writeUInt16LE(1, 6);
			geometry.writeUInt16LE(INPUT_ONLY, 10);
			socket.write(request(CREATE_WINDOW, 0, Buffer.concat([words(window, setup.root), geometry, words(0)])));
			atoms = found;
			owner = { socket, window, maxBytes: setup.maxBytes, clipboard, text: Buffer.alloc(0), ask };
			clearTimeout(timer);
			// An idle connection must not keep the program from ending.
			socket.unref();
			resolve(owner);
		};
		socket.on("data", (chunk) => {
			incoming = Buffer.concat([incoming, chunk]);
			read();
		});
		socket.on("error", fail);
		socket.on("close", () => {
			clearTimeout(timer);
			connection = undefined;
			resolve(undefined);
		});
		socket.on("connect", () => socket.write(setupRequest(cookieFor(display, env))));
	});
}

/** The cookie for a display from the authority file, when that can be read. */
function cookieFor(display: number, env: NodeJS.ProcessEnv): Buffer | undefined {
	try {
		return findCookie(readFileSync(env.XAUTHORITY ?? join(homedir(), ".Xauthority")), display);
	} catch {
		// No file: a server without access control takes the connection as it is.
		return undefined;
	}
}

// The open connection, kept: the text stays available only as long as it lives.
let connection: Promise<Owner | undefined> | undefined;

/** Offer text as the X clipboard and primary selection. True once the server says this program owns them. */
export async function copyViaX11(text: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	// Remote displays have their own routes.
	const display = displayNumber(env.DISPLAY);
	if (display === undefined) return false;
	connection ??= openOwner(display, env);
	const owner = await connection;
	if (!owner) return false;
	// One request carries the text: longer ones would need the INCR protocol.
	const bytes = Buffer.from(text);
	if (bytes.length > owner.maxBytes) return false;
	owner.text = bytes;
	// The primary selection is what the middle button pastes.
	for (const selection of [owner.clipboard, ATOM_PRIMARY]) {
		owner.socket.write(request(SET_SELECTION_OWNER, 0, words(owner.window, selection, 0)));
	}
	// A reply is needed to read the result, so the socket counts while it is awaited.
	owner.socket.ref();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reply = await Promise.race([
		owner.ask(request(GET_SELECTION_OWNER, 0, words(owner.clipboard))),
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), TIMEOUT_MS);
		}),
	]);
	clearTimeout(timer);
	// A server that does not answer is left behind: a late reply would be taken for the next one.
	if (!reply) {
		owner.socket.destroy();
		return false;
	}
	owner.socket.unref();
	return reply.readUInt32LE(8) === owner.window;
}

/** Drop the connection (tests). */
export function closeX11Clipboard(): void {
	void connection?.then((owner) => owner?.socket.destroy());
	connection = undefined;
}
