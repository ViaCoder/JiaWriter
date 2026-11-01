// Preload module (node --import) that records every outbound connection attempt.
// Each attempt is appended as one JSON line to the file named by WA_NET_LOG.

// Append lines synchronously so nothing is lost when the process exits abruptly.
import { appendFileSync } from "node:fs";
// The Socket class every TCP client (http, https, fetch/undici, ws) goes through.
import net from "node:net";
// Host name resolution, the first step of most connections.
import dns from "node:dns";

// Where to write the records; without it the recorder stays silent.
const logFile = process.env.WA_NET_LOG;

/** Write one record when logging is enabled. */
function record(kind, target) {
	// Do nothing unless a log file was requested.
	if (!logFile) return;
	// One JSON object per line: kind of event and its target.
	appendFileSync(logFile, `${JSON.stringify({ kind, target: String(target) })}\n`);
}

// Keep the original connect so normal behaviour is unchanged.
const originalConnect = net.Socket.prototype.connect;
// Wrap Socket.connect to log the destination first.
net.Socket.prototype.connect = function (...args) {
	// Node's net.connect() passes one normalized array [options, callback]; unwrap it.
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	// Options object: host and port (or a unix socket path).
	if (first && typeof first === "object" && !Array.isArray(first)) {
		// Unix sockets have a path; TCP has host/port.
		record("connect", first.path ?? `${first.host ?? "localhost"}:${first.port}`);
	} else {
		// Positional form: port then optional host.
		record("connect", `${args[1] ?? "localhost"}:${first}`);
	}
	// Continue with the real connect.
	return originalConnect.apply(this, args);
};

// Keep the original lookup.
const originalLookup = dns.lookup;
// Wrap dns.lookup to log every name being resolved.
dns.lookup = function (hostname, ...rest) {
	// Record the name before resolving it.
	record("dns", hostname);
	// Continue with the real lookup.
	return originalLookup.call(this, hostname, ...rest);
};
