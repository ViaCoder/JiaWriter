"""search_fetch.url_guard — outbound-URL policy for every fetch path (SSRF guard).

The URLs this engine fetches are chosen by an LLM that reads untrusted web content
(the research picker, the draft-stage `search_fetch_fetch` tool) or are harvested
straight out of fetched pages (linked-document downloads). Without a policy a
prompt-injected page could make the engine:
  * read LOCAL files (`file:///…` — urllib and Chrome both open them) and feed
    them into the corpus that is sent to remote LLM providers, or
  * reach the LAN / loopback / cloud-metadata services (router admin pages,
    the engine's own bridge socket, 169.254.169.254, …).

Policy: only http(s) URLs with a host, and — unless SEARCH_FETCH_ALLOW_PRIVATE=1 —
only hosts whose every resolved address is publicly routable.

DNS rebinding: for urllib requests (`urlopen`: document downloads, type sniffs) the
host is resolved ONCE, validated, and the TCP connection is PINNED to that validated
address (Host header, TLS SNI and certificate verification still use the host name);
every redirect hop is resolved, validated and pinned the same way, and a host that
does not resolve is refused (a direct connection could not succeed anyway).
Residual (see SECURITY.md): through an HTTP(S) proxy the proxy resolves the name
itself, and the headed-browser path cannot be pinned — it gets the pre-check plus
the final-URL check (`check_final_url`) instead.

Browser/parser agreement (2026-10-12): the browser parses URLs with the WHATWG rules,
not Python's urlsplit — it percent-decodes and IDNA-maps the host, treats `\\` like `/`
and reads hex/octal/short IPv4 forms (`0x7f.1`, `0x`) that glibc may not. The host
is therefore canonicalised the browser way BEFORE it is judged (`_canonical_host`), and
a URL whose authority the two parsers read differently is refused outright.

Libraries with their own networking (yt-dlp: probes, subtitles, media downloads and
all of their redirect hops) run inside `guard_resolution()`, which judges every name
resolution of the process on the exact addresses that will be connected to.

Stdlib-only, env read at call time (docparse imports this; tests toggle the env).
"""

import contextlib
import http.client
import ipaddress
import os
import re
import socket
import threading
import urllib.parse
import urllib.request

ALLOWED_SCHEMES = ("http", "https")


class BlockedURL(ValueError):
    """The URL violates the outbound policy; message says why (never fetched)."""


def allow_private() -> bool:
    """SEARCH_FETCH_ALLOW_PRIVATE=1 lifts the public-address rule (intranet research,
    local test fixtures). The http(s)-only scheme rule always applies."""
    return os.environ.get("SEARCH_FETCH_ALLOW_PRIVATE", "0").strip().lower() in (
        "1", "true", "yes", "on")


def _resolve(host: str, port: int) -> list:
    """All addresses `host` resolves to (tests replace this to stay offline)."""
    infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    return [info[4][0] for info in infos]


# IPv6 prefixes whose low 32 bits are an IPv4 address the packet ends up at (Python's
# ipaddress only unpacks ::ffff:0:0/96, 6to4 and Teredo itself).
_V4_EMBEDDING_V6 = (
    ipaddress.ip_network("::/96"),             # IPv4-compatible (deprecated; ::a.b.c.d)
    ipaddress.ip_network("::ffff:0:0:0/96"),   # SIIT IPv4-translated
    ipaddress.ip_network("64:ff9b::/96"),      # NAT64 well-known prefix (RFC 6052)
)
_NOT_PUBLIC_V6 = (
    ipaddress.ip_network("64:ff9b:1::/48"),    # local-use NAT64 (RFC 8215; older Pythons call it global)
    ipaddress.ip_network("fec0::/10"),         # site-local (deprecated, still routed on some LANs)
)


def ip_is_public(addr: str) -> bool:
    """True only for globally routable unicast addresses. IPv6 forms that carry an
    IPv4 address (mapped, IPv4-compatible, SIIT, NAT64 64:ff9b::/96, 6to4, Teredo) are
    judged by the IPv4 address they embed — on a NAT64 network 64:ff9b::a00:1 IS
    10.0.0.1."""
    ip = ipaddress.ip_address(addr.split("%", 1)[0])   # drop an IPv6 zone id
    if ip.version == 6:
        if any(ip in n for n in _NOT_PUBLIC_V6):
            return False
        embedded = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if embedded is None and any(ip in n for n in _V4_EMBEDDING_V6):
            embedded = ipaddress.IPv4Address(ip.packed[12:])
        if embedded is not None:
            ip = embedded
    return ip.is_global and not ip.is_multicast


# ── host canonicalisation: judge the host the way the BROWSER will see it ──
# WHATWG forbidden domain code points (after percent-decoding): a host containing one
# is not a valid browser host, so it is refused rather than guessed at.
_FORBIDDEN_HOST_CHARS = set("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | {chr(c) for c in range(0x20)}
_V4_PART = re.compile(r"(?:0[xX][0-9a-fA-F]*|[0-9]+)")


def _ends_in_number(host: str) -> bool:
    """WHATWG 'ends in a number': such a host MUST parse as IPv4 (or the URL is invalid)."""
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    return bool(_V4_PART.fullmatch(parts[-1]))


def _whatwg_ipv4(host: str):
    """The WHATWG IPv4 parser (1–4 parts; hex `0x…` incl. empty, octal `0…`, decimal;
    the last part fills the remaining bytes). Dotted-quad string, or None = invalid.
    This is what Chrome connects to for `0x7f.1`, `2130706433`, `0x` (0.0.0.0) … —
    independent of what the local libc's inet_aton happens to accept."""
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if not 1 <= len(parts) <= 4:
        return None
    nums = []
    for part in parts:
        if not _V4_PART.fullmatch(part):
            return None
        if part[:2] in ("0x", "0X"):
            n = int(part[2:] or "0", 16)
        elif len(part) > 1 and part[0] == "0":
            if any(c not in "01234567" for c in part):
                return None
            n = int(part, 8)
        else:
            n = int(part)
        nums.append(n)
    if any(n > 255 for n in nums[:-1]) or nums[-1] >= 256 ** (5 - len(nums)):
        return None
    value = nums[-1] + sum(n * 256 ** (3 - i) for i, n in enumerate(nums[:-1]))
    return str(ipaddress.IPv4Address(value))


def _canonical_hosts(raw: str) -> list:
    """The host(s) a browser would look up for `raw` (a URL host, brackets optional):
    percent-decoded, IDNA-mapped to ASCII, lower-cased, trailing dot dropped, numeric
    IPv4 forms normalised to dotted-quad, IPv6 literals compressed. Two entries when an
    internationalised name maps differently under IDNA2003 (stdlib) and UTS #46 (the
    `idna` package, what Chrome uses) — both are judged. Raises BlockedURL when the
    host is not a valid browser host."""
    h = raw[1:-1] if raw.startswith("[") and raw.endswith("]") else raw
    try:
        h = urllib.parse.unquote(h, errors="strict")
    except UnicodeDecodeError:
        raise BlockedURL(f"malformed host {raw!r}") from None
    if ":" in h:                                      # IPv6 literal (zone id allowed)
        try:
            return [str(ipaddress.IPv6Address(h.split("%", 1)[0]))]
        except ValueError:
            raise BlockedURL(f"malformed host {raw!r}") from None
    forms = []
    if h.isascii():
        forms.append(h)
    else:
        try:
            forms.append(h.encode("idna").decode("ascii"))       # IDNA2003 / nameprep
        except UnicodeError:
            raise BlockedURL(f"host {raw!r} is not a valid internationalised name") from None
        try:
            import idna  # UTS #46 (optional)
            alt = idna.encode(h.rstrip(".。．｡"), uts46=True, transitional=False).decode("ascii")
            forms.append(alt)
        except Exception:
            pass
    out = []
    for f in forms:
        f = f.lower()
        if not f or any(c in _FORBIDDEN_HOST_CHARS for c in f):
            raise BlockedURL(f"malformed host {raw!r}")
        if _ends_in_number(f):
            ip = _whatwg_ipv4(f)
            if ip is None:
                raise BlockedURL(f"malformed IPv4 host {raw!r}")
            f = ip
        f = f.rstrip(".")
        if f and f not in out:
            out.append(f)
    if not out:
        raise BlockedURL(f"malformed host {raw!r}")
    return out


def _browser_host(url: str) -> str:
    """The raw host a WHATWG parser reads for a special (http/https) URL: tab/LF/CR
    removed, any run of '/' or '\\' after the scheme skipped, the authority ends at the
    first '/', '\\', '?' or '#', userinfo ends at the LAST '@'. Python's urlsplit does
    not treat '\\' as a delimiter — `http://127.0.0.1\\@example.org/` is example.org to
    Python but 127.0.0.1 to Chrome."""
    s = re.sub(r"[\t\n\r]", "", (url or "").strip("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a"
                                                    "\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14"
                                                    "\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f "))
    rest = s.split(":", 1)[1] if ":" in s else ""
    rest = rest.lstrip("/\\")
    auth = re.split(r"[/\\?#]", rest, maxsplit=1)[0]
    hostport = auth.rpartition("@")[2]
    if hostport.startswith("["):
        end = hostport.find("]")
        return hostport[:end + 1] if end != -1 else hostport
    return hostport.split(":", 1)[0]


def _vet(url: str, strict: bool):
    """Validate `url`; return (host, port, pinned_ip). pinned_ip is the first of the
    validated addresses, or None when there is nothing to pin (private targets
    allowed by opt-in, or a non-strict check of an unresolvable host). `strict`
    (the urllib connection path) refuses an unresolvable host instead.
    The host is judged in its browser-canonical form (`_canonical_hosts`), and a URL
    whose host Python and a browser would read differently is refused."""
    try:
        p = urllib.parse.urlsplit((url or "").strip())
        port = p.port
    except ValueError as ex:
        raise BlockedURL(f"malformed URL ({ex})") from None
    scheme = (p.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise BlockedURL(f"scheme not allowed: {scheme or '(none)'} — only http(s) URLs are fetched")
    raw_host = p.hostname or ""
    if not raw_host.rstrip("."):
        raise BlockedURL("URL has no host")
    port = port or (443 if scheme == "https" else 80)
    if allow_private():
        return raw_host.rstrip("."), port, None
    hosts = _canonical_hosts(raw_host)
    browser_raw = _browser_host(url)
    if not browser_raw or _canonical_hosts(browser_raw) != hosts:
        raise BlockedURL(f"ambiguous URL: a browser would read its host as {browser_raw!r}, "
                         f"not {raw_host!r}")
    addrs = []
    for host in hosts:
        if host == "localhost" or host.endswith(".localhost"):
            raise BlockedURL(f"non-public host {host}")
        try:
            addrs.append(str(ipaddress.ip_address(host)))   # literal IP: judge it directly
            continue
        except ValueError:
            pass
        try:
            got = _resolve(host, port)
        except (OSError, UnicodeError):
            got = []
        if not got and strict:
            raise BlockedURL(f"cannot resolve host {host}") from None
        addrs += got
    if not addrs:
        return hosts[0], port, None
    for a in addrs:
        try:
            public = ip_is_public(a)
        except ValueError:
            public = False
        if not public:
            raise BlockedURL(f"non-public address {a} for host {hosts[0]} "
                             "(set SEARCH_FETCH_ALLOW_PRIVATE=1 to allow intranet targets)")
    return hosts[0], port, addrs[0].split("%", 1)[0]


def check_url(url: str) -> str:
    """Return `url` unchanged when it may be fetched; raise BlockedURL otherwise.
    An unresolvable host is let through HERE (the browser path may still reach it
    through a system proxy) — there is no address to judge. The urllib path
    (`urlopen`) is strict and pins the connection instead."""
    _vet(url, strict=False)
    return url


def check_final_url(url: str) -> str:
    """Post-navigation check for the BROWSER path: a page that redirected to a
    non-public http(s) address must not be emitted. Non-http finals (about:blank
    for a download, chrome-error://…) carry no fetched content of their own and
    are left to the existing empty-render handling."""
    scheme = urllib.parse.urlsplit(url or "").scheme.lower()
    if scheme in ALLOWED_SCHEMES:
        check_url(url)
    return url


# ── process-wide resolution guard (libraries with their own HTTP stack) ──
_sys_getaddrinfo = socket.getaddrinfo   # the real resolver (tests replace it)
_guard_lock = threading.Lock()
_guard_depth = 0
_guard_saved = None


def _proxy_hosts() -> set:
    """Host names of the env-configured proxies: connecting to the proxy itself is
    allowed (it may well live on the LAN/loopback); the proxy resolves the targets."""
    out = set()
    for v in urllib.request.getproxies().values():
        try:
            h = urllib.parse.urlsplit(v if "://" in v else "//" + v).hostname
        except ValueError:
            continue
        if h:
            out.add(h.rstrip(".").lower())
    return out


def _guarded_getaddrinfo(host, port, *args, **kwargs):
    infos = _sys_getaddrinfo(host, port, *args, **kwargs)
    if host is None or not _guard_depth or allow_private():
        return infos
    name = host.decode("ascii", "replace") if isinstance(host, (bytes, bytearray)) else str(host)
    if name.rstrip(".").lower() in _proxy_hosts():
        return infos
    for info in infos:
        addr = str(info[4][0])
        try:
            public = ip_is_public(addr)
        except ValueError:
            public = False
        if not public:
            raise socket.gaierror(socket.EAI_NONAME,
                                  f"url_guard: non-public address {addr} for host {name} "
                                  "(set SEARCH_FETCH_ALLOW_PRIVATE=1 to allow intranet targets)")
    return infos


@contextlib.contextmanager
def guard_resolution():
    """While active, EVERY socket.getaddrinfo in this process refuses names/literals
    that resolve to a non-public address (unless SEARCH_FETCH_ALLOW_PRIVATE=1; the
    configured proxy host is exempt). The check runs on the very addresses the caller
    then connects to, so it also covers redirect hops and DNS rebinding for libraries
    that resolve through Python's socket module (yt-dlp's urllib/requests handlers,
    websockets). Not covered: helpers that resolve in native code or another process
    (ffmpeg, curl_cffi). Process-wide (not per thread) and re-entrant: the media paths
    that use it run without concurrent intranet traffic (the browser bridge is not in use)."""
    global _guard_depth, _guard_saved
    with _guard_lock:
        if _guard_depth == 0:
            _guard_saved = socket.getaddrinfo
            socket.getaddrinfo = _guarded_getaddrinfo
        _guard_depth += 1
    try:
        yield
    finally:
        with _guard_lock:
            _guard_depth -= 1
            if _guard_depth == 0:
                socket.getaddrinfo = _guard_saved
                _guard_saved = None


def _via_proxy(url: str) -> bool:
    """True when urllib's ProxyHandler will route `url` through an env-configured proxy
    (the proxy resolves the name; a local resolution failure is then not fatal)."""
    try:
        p = urllib.parse.urlsplit(url)
        proxies = urllib.request.getproxies()
        return bool(proxies.get(p.scheme.lower())) and not urllib.request.proxy_bypass(p.hostname or "")
    except Exception:
        return False


def _pin(req, vetted=None):
    """Vet req.full_url (unless `vetted` — the (host, port, ip) of a check already done
    for this exact URL) and remember the validated address on the request object."""
    host, port, ip = vetted or _vet(req.full_url, strict=not _via_proxy(req.full_url))
    req._sf_pin = ip
    req._sf_pin_hostport = req.host        # the host[:port] the pin belongs to
    return req


def _pinned_conn_factory(conn_cls, req):
    """Connection factory for do_open: connect to the request's pinned address while
    keeping `host` (Host header, SNI, certificate hostname) the real name. No pin
    when the request was rewritten to go through a proxy (the proxy connects)."""
    ip = getattr(req, "_sf_pin", None)
    if ip and (req.host != getattr(req, "_sf_pin_hostport", None) or getattr(req, "_tunnel_host", None)):
        ip = None

    def make(host, **kw):
        conn = conn_cls(host, **kw)
        if ip:
            real_create = conn._create_connection

            def _create(address, *a, **k):
                return real_create((ip, address[1]), *a, **k)

            conn._create_connection = _create
        return conn

    return make


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_pinned_conn_factory(http.client.HTTPConnection, req), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_pinned_conn_factory(http.client.HTTPSConnection, req), req,
                            context=self._context)


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-applies the policy to every redirect hop and pins the new hop's
    connection to ITS validated address (stock urllib follows redirects to any
    http/https/ftp target, including private addresses, re-resolving freely)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        vetted = _vet(target, strict=not _via_proxy(target))   # ONE resolution per hop
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            _pin(new, vetted)
        return new


def urlopen(req, timeout=None, context=None):
    """urllib.request.urlopen with the outbound policy applied to the request URL
    and every redirect hop, each connection pinned to the address that was
    validated. `context` (an ssl.SSLContext) is for tests / custom trust stores."""
    if not isinstance(req, urllib.request.Request):
        req = urllib.request.Request(str(req))
    _pin(req)
    opener = urllib.request.build_opener(
        _PinnedHTTPHandler, _PinnedHTTPSHandler(context=context), _GuardedRedirectHandler)
    return opener.open(req, timeout=timeout)
