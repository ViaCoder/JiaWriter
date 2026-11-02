/**
 * Outbound address policy for pages the browser opens on the model's request: only http(s), and
 * never this computer or the local network (a page or document cannot steer the agent at a router
 * or an intranet site). Hostnames are resolved first, so a public name pointing at a private
 * address is refused too.
 */

// Name resolution.
import { lookup } from "node:dns/promises";
// Literal address checks.
import { isIP } from "node:net";

/** True for loopback, private, link-local, carrier-grade NAT, benchmark, multicast and reserved IPv4/IPv6 addresses. */
export function isPrivateAddress(ip: string): boolean {
	// IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as IPv4.
	const v4 = ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
	if (isIP(v4) === 4) {
		const [a, b] = v4.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (isIP(v4) === 6) {
		const s = v4.toLowerCase();
		// Unspecified, loopback, unique local (fc00::/7), link-local (fe80::/10), multicast.
		return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
	}
	// Not an address.
	return false;
}

/** Throw unless url is http(s) and its host is public; resolve hostnames with lookupAll. */
export async function checkPublicUrl(
	url: string,
	lookupAll: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address),
): Promise<void> {
	// Parse.
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`not a web address: ${url}`);
	}
	// Web schemes only.
	if (u.protocol !== "http:" && u.protocol !== "https:")
		throw new Error(`only http(s) addresses can be opened: ${url}`);
	// Host without IPv6 brackets.
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	// Local names.
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
		throw new Error(`local address refused: ${host}`);
	// A literal address, or every address the name resolves to (a name this computer cannot resolve
	// is left to Chrome, which may reach it through a proxy).
	const addrs = isIP(host) ? [host] : await lookupAll(host).catch(() => [] as string[]);
	if (addrs.some(isPrivateAddress)) throw new Error(`local network address refused: ${host}`);
}
