#!/usr/bin/env python3
"""Outbound-URL policy (url_guard) — SSRF / local-file-read regression tests.

Stdlib only, ZERO network: DNS is replaced by a fake resolver, every urllib open
is either refused before connecting or served by a throwaway 127.0.0.1 server,
and the browser is never started (its entry points are replaced by tripwires).
Scratch files live under tests/tmp/ (gitignored). Run: python3 tests/test_url_guard.py
"""
import asyncio
import contextlib
import http.client
import http.server
import io
import os
import shutil
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

_PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_PROJ, "src"))
_TMPBASE = Path(__file__).resolve().parent / "tmp"
_TMPBASE.mkdir(parents=True, exist_ok=True)
_TMP = tempfile.mkdtemp(prefix="urlguard-", dir=str(_TMPBASE))
os.environ.pop("SEARCH_FETCH_ALLOW_PRIVATE", None)

from search_fetch import config, url_guard  # noqa: E402

_fail = 0
PUBLIC_IP = "93.184.215.14"   # a globally routable documentation-site address


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def blocked(url) -> bool:
    try:
        url_guard.check_url(url)
        return False
    except url_guard.BlockedURL:
        return True


@contextlib.contextmanager
def fake_dns(table=None, error=None):
    """Replace the resolver: host → list of addresses, or raise `error`. Records calls."""
    calls = []

    def _resolve(host, port):
        calls.append(host)
        if error is not None:
            raise error
        return list((table or {}).get(host, [PUBLIC_IP]))

    saved = url_guard._resolve
    url_guard._resolve = _resolve
    try:
        yield calls
    finally:
        url_guard._resolve = saved


@contextlib.contextmanager
def env(**kv):
    saved = {k: os.environ.get(k) for k in kv}
    os.environ.update({k: v for k, v in kv.items()})
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_schemes():
    print("── scheme / shape rules")
    with fake_dns() as calls:
        for u in ("file:///etc/passwd", "FILE:///home/x/.ssh/id_ed25519", "file://localhost/etc/hosts",
                  "ftp://example.org/a.pdf", "data:text/plain,hi", "javascript:alert(1)",
                  "gopher://example.org/", "chrome://settings", "about:blank",
                  "example.org/no-scheme.pdf", "", "   "):
            check(f"blocked scheme: {u!r}", blocked(u))
        check("no host → blocked", blocked("http:///etc/passwd"))
        check("bad port → blocked (not a crash)", blocked("http://example.org:99999/"))
        check("non-numeric port → blocked", blocked("http://example.org:abc/"))
        check("scheme rejections never touch DNS", calls == [])
        check("public https allowed", not blocked("https://example.org/report.pdf"))
        check("public http allowed", not blocked("http://example.org/a?b=c#frag"))


def test_addresses():
    print("── address rules (literal IPs, no DNS)")
    with fake_dns(error=AssertionError("literal IPs must not be resolved")):
        for u in ("http://127.0.0.1:9522/json/version", "http://127.1.2.3/", "http://0.0.0.0/",
                  "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.77.23/",
                  "http://192.168.77.52:8080/", "http://169.254.169.254/latest/meta-data/",
                  "http://100.64.0.1/", "http://224.0.0.1/", "http://255.255.255.255/",
                  "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/",
                  "http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.0.1]/",
                  "http://[2002:7f00:1::]/", "http://[ff02::1]/"):
            check(f"non-public literal blocked: {u}", blocked(u))
        check("public v4 literal allowed", not blocked("http://8.8.8.8/"))
        check("public v6 literal allowed", not blocked("http://[2606:4700:4700::1111]/"))
        # The embedded IPv4 decides (Python's ipaddress calls ALL of ::ffff:0:0/96 non-global,
        # so without the unwrapping a mapped PUBLIC address would be wrongly refused).
        check("IPv4-mapped PUBLIC address allowed (judged by the embedded v4)",
              not blocked("http://[::ffff:8.8.8.8]/"))
    check("zone-id link-local is not public", not url_guard.ip_is_public("fe80::1%eth0"))
    check("garbage address is rejected by ip_is_public",
          _raises(lambda: url_guard.ip_is_public("not-an-ip"), ValueError))


def _raises(fn, exc) -> bool:
    try:
        fn()
        return False
    except exc:
        return True


def test_names():
    print("── host names (fake resolver)")
    with fake_dns(error=AssertionError("localhost must be refused without DNS")):
        check("localhost blocked", blocked("http://localhost:9522/json"))
        check("LOCALHOST. (case + trailing dot) blocked", blocked("http://LOCALHOST./"))
        check("*.localhost blocked", blocked("http://cdp.localhost/"))
    with fake_dns({"intranet.example": ["192.168.77.1"]}):
        check("name resolving to LAN blocked", blocked("https://intranet.example/x.pdf"))
    with fake_dns({"rebind.example": [PUBLIC_IP, "127.0.0.1"]}):
        check("ANY non-public address blocks (mixed answer)", blocked("http://rebind.example/"))
    with fake_dns({"meta.example": ["169.254.169.254"]}):
        check("cloud-metadata address via DNS blocked", blocked("http://meta.example/"))
    with fake_dns({"v6.example": ["::ffff:10.1.2.3"]}):
        check("IPv4-mapped private via DNS blocked", blocked("http://v6.example/"))
    with fake_dns({"cdn.example": [PUBLIC_IP, "2606:4700::6810:84e5"]}) as calls:
        check("all-public answer allowed", not blocked("https://cdn.example/a"))
        check("resolver was consulted", calls == ["cdn.example"])
    with fake_dns(error=socket.gaierror("no such host")):
        check("unresolvable host passes (request fails on its own)",
              not blocked("https://no-such-host.invalid/"))
    # Numeric host forms that inet_aton accepts are parsed locally by getaddrinfo
    # (no DNS query) — the decimal form of 127.0.0.1 must not slip through.
    try:
        socket.getaddrinfo("2130706433", 80)
        check("decimal-encoded loopback (2130706433) blocked", blocked("http://2130706433/"))
    except OSError:
        print("  - skip decimal-IP check (resolver does not parse numeric hosts)")


def test_browser_parser_agreement():
    """2026-10-12: the BROWSER path resolves the host itself, so the pre-check must judge
    the host the way Chrome's (WHATWG) URL parser will see it — not just Python's
    urlsplit + getaddrinfo. Every case uses a resolver that knows NO names (a name the
    local resolver cannot resolve is let through by design), so only parsing decides."""
    print("── browser/WHATWG parser agreement (no DNS answers)")
    with fake_dns(error=socket.gaierror("offline: no names")):
        for u in ("http://%31%32%37.0.0.1/",            # percent-encoded host → 127.0.0.1
                  "http://127.0.0.1%2e/",               # %2e = trailing dot
                  "http://0x/",                         # WHATWG: empty hex = 0 → 0.0.0.0
                  "http://0x7f.0x.0x.0x1:9222/json",    # glibc rejects "0x", Chrome does not
                  "http://0x7F.1/",
                  "http://127.0.0.1\\@example.org/",    # Chrome: '\' ends the authority
                  "http://127.0.0.1\\example.org/",
                  "http://ⓛocalhost/",                   # IDNA-maps to localhost
                  "http://１２７.０.０.１/",                # full-width digits/dots
                  "http://127.0.0.1。/",                # ideographic full stop
                  "http://1.2.3.4.5/",                  # ends in a number, not IPv4 → invalid
                  "http://foo.0x7f/",
                  "http://[::127.0.0.1]/",              # IPv4-compatible (deprecated)
                  "http://[::ffff:0:127.0.0.1]/",       # SIIT IPv4-translated
                  "http://[64:ff9b::10.0.0.1]/",        # NAT64 well-known prefix → LAN
                  "http://[64:ff9b::169.254.169.254]/", # NAT64 → cloud metadata
                  "http://[64:ff9b:1::a00:1]/",         # local-use NAT64
                  "http://[fec0::1]/"):                 # site-local (deprecated)
            check(f"blocked: {u}", blocked(u))
        check("NAT64 of a PUBLIC IPv4 still allowed", not blocked("http://[64:ff9b::8.8.8.8]/"))
        check("underscore host (some CDNs) still allowed", not blocked("https://my_cdn.example.org/a"))
        check("percent-escapes in the PATH are fine", not blocked("https://example.org/%7Euser/a%2Fb"))
        check("backslash in the QUERY is fine", not blocked("https://example.org/a?p=x\\y"))
    with fake_dns({"xn--bcher-kva.example": [PUBLIC_IP]}) as calls:
        check("IDN host allowed when its punycode name is public", not blocked("https://bücher.example/a"))
        check("IDN resolved under its punycode (the name Chrome looks up)", calls == ["xn--bcher-kva.example"])
    with fake_dns({"xn--bcher-kva.example": ["10.9.8.7"]}):
        check("IDN host whose punycode name is private → blocked", blocked("https://bücher.example/a"))
    with fake_dns({"intranet.example": ["192.168.7.7"]}):
        check("percent-encoded NAME is decoded before resolving", blocked("http://intr%61net.example/"))
    with fake_dns(error=AssertionError("strict path must judge the literal without DNS")):
        check("strict (urllib) path agrees: percent-encoded loopback refused",
              _raises(lambda: url_guard._vet("http://%31%32%37.0.0.1/", strict=True), url_guard.BlockedURL))


def test_resolution_guard():
    """2026-10-12: libraries that do their own networking (yt-dlp: probe, subtitle and
    media requests, EVERY redirect hop) run inside url_guard.guard_resolution(): each
    name resolution is judged on the exact addresses the library will connect to."""
    print("── guard_resolution (process resolver hook for yt-dlp)")
    table = {"pub.example": [PUBLIC_IP], "intranet.example": ["10.0.0.5"],
             "meta.example": ["169.254.169.254"], "127.0.0.1": ["127.0.0.1"],
             "mixed.example": [PUBLIC_IP, "192.168.0.9"], "proxy.lan": ["192.168.77.2"]}

    def fake_gai(host, port, *a, **k):
        if isinstance(host, bytes):
            host = host.decode()
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))
                for ip in table.get(host, [])] or (_ for _ in ()).throw(socket.gaierror("nx"))

    saved = url_guard._sys_getaddrinfo
    url_guard._sys_getaddrinfo = fake_gai
    real = socket.getaddrinfo
    try:
        with env(http_proxy="", https_proxy="", HTTP_PROXY="", HTTPS_PROXY="", all_proxy="", ALL_PROXY=""):
            with url_guard.guard_resolution():
                check("public name resolves inside the guard",
                      socket.getaddrinfo("pub.example", 443)[0][4][0] == PUBLIC_IP)
                for h in ("intranet.example", "meta.example", "127.0.0.1", "mixed.example"):
                    check(f"{h} refused inside the guard",
                          _raises(lambda h=h: socket.getaddrinfo(h, 80), socket.gaierror))
                with url_guard.guard_resolution():   # nesting is fine
                    check("nested guard still active", _raises(lambda: socket.getaddrinfo("intranet.example", 80),
                                                               socket.gaierror))
                check("outer guard still active after a nested exit",
                      _raises(lambda: socket.getaddrinfo("intranet.example", 80), socket.gaierror))
            check("resolver restored after the guard", socket.getaddrinfo is real)
            with env(SEARCH_FETCH_ALLOW_PRIVATE="1"), url_guard.guard_resolution():
                check("ALLOW_PRIVATE=1 lifts the address rule",
                      socket.getaddrinfo("intranet.example", 80)[0][4][0] == "10.0.0.5")
        with env(http_proxy="http://proxy.lan:3128", https_proxy="http://proxy.lan:3128"), \
                url_guard.guard_resolution():
            check("the configured proxy host itself may be resolved (the proxy then resolves targets)",
                  socket.getaddrinfo("proxy.lan", 3128)[0][4][0] == "192.168.77.2")
            check("…but other private names are still refused",
                  _raises(lambda: socket.getaddrinfo("intranet.example", 80), socket.gaierror))
    finally:
        url_guard._sys_getaddrinfo = saved
        socket.getaddrinfo = real


def test_allow_private():
    print("── SEARCH_FETCH_ALLOW_PRIVATE")
    with env(SEARCH_FETCH_ALLOW_PRIVATE="1"), fake_dns(error=AssertionError("no DNS when allowed")):
        check("opt-in allows loopback", not blocked("http://127.0.0.1:8000/fixture.html"))
        check("opt-in allows LAN name", not blocked("http://localhost/"))
        check("opt-in still refuses file://", blocked("file:///etc/passwd"))
        check("opt-in still refuses ftp://", blocked("ftp://10.0.0.1/a"))
    with env(SEARCH_FETCH_ALLOW_PRIVATE="0"):
        check("explicit 0 keeps the guard", blocked("http://127.0.0.1/"))
    with env(SEARCH_FETCH_ALLOW_PRIVATE="garbage"):
        check("unknown value keeps the guard", blocked("http://127.0.0.1/"))


def test_final_url():
    print("── browser final URL check")
    with fake_dns():
        for u in ("about:blank", "chrome-error://chromewebdata/", ""):
            check(f"non-http final passes through: {u!r}",
                  not _raises(lambda u=u: url_guard.check_final_url(u), url_guard.BlockedURL))
        check("redirected-to-LAN final blocked",
              _raises(lambda: url_guard.check_final_url("http://10.0.0.5/admin"), url_guard.BlockedURL))
        check("public final passes",
              not _raises(lambda: url_guard.check_final_url("https://example.org/a"), url_guard.BlockedURL))


def test_redirect_handler_unit():
    print("── redirect hop re-check (unit)")
    h = url_guard._GuardedRedirectHandler()
    req = urllib.request.Request(f"http://{PUBLIC_IP}/start")
    with fake_dns():
        for target in ("http://127.0.0.1:9522/json", "file:///etc/passwd",
                       "http://[::1]/", "ftp://example.org/x"):
            check(f"redirect to {target} refused",
                  _raises(lambda target=target: h.redirect_request(req, None, 302, "Found", {}, target),
                          url_guard.BlockedURL))
        # (urllib's http_error_30x has already joined a relative Location onto the base)
        ok = h.redirect_request(req, None, 302, "Found", {}, f"http://{PUBLIC_IP}/next.pdf")
        check("redirect to a public address followed",
              ok is not None and ok.full_url == f"http://{PUBLIC_IP}/next.pdf")


class _Srv(http.server.BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):
        _Srv.hits.append(self.path)
        if self.path == "/redir-private":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.2:{self.server.server_address[1]}/secret")
            self.end_headers()
        elif self.path == "/redir-file":
            self.send_response(302)
            self.send_header("Location", "file:///etc/hostname")
            self.end_headers()
        else:
            body = b"%PDF-1.4 fixture"
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    do_HEAD = do_GET

    def log_message(self, *a):
        pass


def test_redirect_end_to_end():
    print("── redirect hop re-check (local server, 127.0.0.1 treated as 'public')")
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Srv)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    saved = url_guard.ip_is_public
    url_guard.ip_is_public = lambda a: a == "127.0.0.1"   # the test server only
    try:
        _Srv.hits.clear()
        r = url_guard.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/ok.pdf"), timeout=5)
        check("allowed URL is fetched", r.read().startswith(b"%PDF-"))
        r.close()
        check("redirect into a non-public address raises",
              _raises(lambda: url_guard.urlopen(
                  urllib.request.Request(f"http://127.0.0.1:{port}/redir-private"), timeout=5),
                  url_guard.BlockedURL))
        check("the non-public redirect target was never requested", "/secret" not in _Srv.hits)
        # (stock urllib already refuses a file:// Location with HTTPError before our
        # hook runs — either refusal is fine; the local file must never be opened)
        check("redirect to file:// refused",
              _raises(lambda: url_guard.urlopen(
                  urllib.request.Request(f"http://127.0.0.1:{port}/redir-file"), timeout=5),
                  (url_guard.BlockedURL, urllib.error.HTTPError)))
    finally:
        url_guard.ip_is_public = saved
        httpd.shutdown()


class _Rec(http.server.BaseHTTPRequestHandler):
    """Records (server-label, path, Host) for every request; /redir bounces to rebind2.test."""
    log = []

    def do_GET(self):
        _Rec.log.append((self.server.label, self.path, self.headers.get("Host", "")))
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", f"http://rebind2.test:{self.server.server_address[1]}/hop2")
            self.end_headers()
            return
        body = f"served-by-{self.server.label}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def _serve(addr, label, tls_ctx=None):
    httpd = http.server.ThreadingHTTPServer(addr, _Rec)
    httpd.label = label
    if tls_ctx is not None:
        httpd.socket = tls_ctx.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


@contextlib.contextmanager
def rebinding_dns(names, first="127.0.0.1", then="127.0.0.2"):
    """socket.getaddrinfo replacement: each name in `names` answers `first` on its FIRST
    lookup and `then` (the attacker's private address) on every later one — the
    classic rebinding race. Numeric hosts go to the real resolver (no DNS traffic).
    127.0.0.1 is declared 'public' for the test; 127.0.0.2 stays non-public."""
    real = socket.getaddrinfo
    calls = []

    def fake(host, port, *a, **k):
        if host in names:
            n = sum(1 for c in calls if c == host)
            calls.append(host)
            ip = first if n == 0 else then
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]
        return real(host, port, *a, **k)

    saved_pub = url_guard.ip_is_public
    url_guard.ip_is_public = lambda a: a == first
    socket.getaddrinfo = fake
    proxy_env = {k: os.environ.pop(k) for k in list(os.environ)
                 if k.lower() in ("http_proxy", "https_proxy", "all_proxy")}
    try:
        yield calls
    finally:
        socket.getaddrinfo = real
        url_guard.ip_is_public = saved_pub
        os.environ.update(proxy_env)


def _make_cert(tmp: Path, name: str):
    """Self-signed cert for `name` (SAN) via the openssl CLI; None when unavailable."""
    key, crt = tmp / "test-only.key", tmp / "test-only.crt"
    try:
        import subprocess
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt",
                        "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", f"/CN={name}",
                        "-addext", f"subjectAltName=DNS:{name}", "-keyout", str(key), "-out", str(crt)],
                       check=True, capture_output=True, timeout=30)
        return key, crt
    except Exception:
        return None


def test_dns_rebinding_pinned():
    print("── DNS rebinding: connection pinned to the validated address")
    good = _serve(("127.0.0.1", 0), "validated")
    port = good.server_address[1]
    try:
        evil = _serve(("127.0.0.2", port), "rebound")
    except OSError:
        print("  - skip rebinding checks (127.0.0.2 unavailable)")
        good.shutdown()
        return
    try:
        # Control: stock urllib re-resolves at connect time and lands on the rebound
        # (private) address — the race the pin closes.
        with rebinding_dns({"rebind.test"}):
            _Rec.log.clear()
            url_guard.check_url(f"http://rebind.test:{port}/x")           # check: 1st answer
            body = urllib.request.urlopen(f"http://rebind.test:{port}/x", timeout=5).read()
            check("control: unpinned urllib follows the rebind (vulnerable pattern)",
                  body == b"served-by-rebound")
        with rebinding_dns({"rebind.test"}) as calls:
            _Rec.log.clear()
            body = url_guard.urlopen(urllib.request.Request(f"http://rebind.test:{port}/x"),
                                     timeout=5).read()
            check("pinned: served by the validated address", body == b"served-by-validated")
            check("pinned: resolved exactly once", calls == ["rebind.test"])
            check("pinned: Host header keeps the real name",
                  _Rec.log == [("validated", "/x", f"rebind.test:{port}")])
        with rebinding_dns({"rebind.test", "rebind2.test"}) as calls:
            _Rec.log.clear()
            body = url_guard.urlopen(urllib.request.Request(f"http://rebind.test:{port}/redir"),
                                     timeout=5).read()
            check("redirect hop pinned to ITS validated address", body == b"served-by-validated")
            check("no request ever reached the rebound address",
                  all(lbl == "validated" for lbl, _, _ in _Rec.log) and len(_Rec.log) == 2)
            check("hop Host header is the hop's name", _Rec.log[-1][2] == f"rebind2.test:{port}")
            check("each name resolved once", sorted(calls) == ["rebind.test", "rebind2.test"])
        with fake_dns(error=socket.gaierror("nxdomain")):
            check("urlopen refuses an unresolvable host (no unpinned fallback)",
                  _raises(lambda: url_guard.urlopen(urllib.request.Request("http://nx.test/a"), timeout=5),
                          url_guard.BlockedURL))
    finally:
        good.shutdown()
        evil.shutdown()

    # Through an env-configured proxy the PROXY connects (and resolves): no pin is
    # applied to the proxy connection, and a locally-unresolvable name is not fatal.
    with env(http_proxy="http://127.0.0.1:9", no_proxy=""), \
            fake_dns(error=socket.gaierror("proxy-only DNS")):
        check("proxy detected for http", url_guard._via_proxy("http://intranet-only.test/a"))
        r = urllib.request.Request("http://intranet-only.test/a")
        url_guard._pin(r)
        r.set_proxy("127.0.0.1:9", "http")
        conn = url_guard._pinned_conn_factory(http.client.HTTPConnection, r)("127.0.0.1:9")
        check("no pin on a proxied connection", conn._create_connection is socket.create_connection)
    with fake_dns({"pin.test": [PUBLIC_IP]}):
        r = url_guard._pin(urllib.request.Request("http://pin.test:8080/a"))
        seen = []
        saved_cc = socket.create_connection
        try:
            socket.create_connection = lambda addr, *a, **k: seen.append(addr) or (_ for _ in ()).throw(OSError("stop"))
            conn2 = url_guard._pinned_conn_factory(http.client.HTTPConnection, r)("pin.test:8080")
            try:
                conn2.connect()
            except OSError:
                pass
        finally:
            socket.create_connection = saved_cc
        check("direct connection goes to the pinned IP and the URL's port",
              seen == [(PUBLIC_IP, 8080)])

    # HTTPS: pinned TCP connection, but SNI + certificate verification use the NAME.
    import ssl
    cert = _make_cert(Path(_TMP), "rebind.test")
    if not cert:
        print("  - skip TLS pinning check (openssl unavailable)")
        return
    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sctx.load_cert_chain(str(cert[1]), str(cert[0]))
    sni = []
    sctx.sni_callback = lambda sock, name, ctx: sni.append(name)
    tls = _serve(("127.0.0.1", 0), "validated", tls_ctx=sctx)
    try:
        cctx = ssl.create_default_context(cafile=str(cert[1]))
        with rebinding_dns({"rebind.test"}):
            body = url_guard.urlopen(urllib.request.Request(
                f"https://rebind.test:{tls.server_address[1]}/tls"), timeout=5, context=cctx).read()
        check("https pinned + cert verified against the host name", body == b"served-by-validated")
        check("https SNI is the host name, not the pinned IP", sni == ["rebind.test"])
    finally:
        tls.shutdown()
        for f in cert:
            f.unlink(missing_ok=True)


def test_docparse_paths():
    print("── docparse never opens file:// or private targets")
    from search_fetch import docparse
    secret = Path(_TMP) / "canary.pdf"
    secret.write_bytes(b"%PDF-1.4\nCANARY-LOCAL-FILE\n")
    opened = []
    saved_build = url_guard.urllib.request.build_opener

    def _spy_build(*a, **k):
        opened.append(a)
        raise AssertionError("no connection may be attempted for a refused URL")

    url_guard.urllib.request.build_opener = _spy_build
    try:
        with fake_dns(), contextlib.redirect_stderr(io.StringIO()):
            check("_http_get(file://) raises BlockedURL",
                  _raises(lambda: docparse._http_get(secret.as_uri()), url_guard.BlockedURL))
            check("try_fetch_document(file://…pdf) → None", docparse.try_fetch_document(secret.as_uri()) is None)
            check("try_fetch_document(assume_doc, file://) → None",
                  docparse.try_fetch_document(secret.as_uri(), assume_doc=True, keep_bytes=True) is None)
            import urllib.parse as _up
            wrapped = "https://www.google.com/url?q=" + _up.quote(secret.as_uri(), safe="")
            check("SERP-redirect wrapper unwrapping to file:// → None",
                  docparse.try_fetch_document(wrapped) is None)
            ddg = "https://duckduckgo.com/l/?uddg=" + _up.quote("http://10.0.0.7/r.pdf", safe="")
            check("ddg wrapper unwrapping to a LAN pdf → None", docparse.try_fetch_document(ddg) is None)
            check("sniff_remote_kind(file://) → ''", docparse.sniff_remote_kind(secret.as_uri()) == "")
            check("sniff_remote_kind(LAN) → ''",
                  docparse.sniff_remote_kind("http://192.168.77.1/download?id=1") == "")
            check("try_fetch_document(metadata IP) → None",
                  docparse.try_fetch_document("http://169.254.169.254/latest/x.pdf") is None)
        check("no opener was ever built for refused URLs", opened == [])
    finally:
        url_guard.urllib.request.build_opener = saved_build


def test_page_doc_harvest():
    print("── linked-document harvest skips LAN links")
    from search_fetch import docparse, fetch
    html = ('<a href="http://192.168.77.1/cfg/backup.pdf">a</a>'
            '<a href="http://127.0.0.1:9522/json/download">b</a>'
            '<a href="file:///etc/passwd.pdf">c</a>')
    calls = []
    saved_open = docparse._urlopen

    def _spy(req, timeout=None):
        calls.append(req.full_url)
        return saved_open(req, timeout)          # the real guard decides

    docparse._urlopen = _spy
    cwd = os.getcwd()
    os.chdir(_TMP)
    try:
        with fake_dns(), contextlib.redirect_stderr(io.StringIO()):
            rows = fetch._grab_page_docs(html, f"http://{PUBLIC_IP}/landing", defer=True)
        check("no LAN/loopback document saved", rows == [])
        check("file:// link never even attempted", not any(c.startswith("file:") for c in calls))
        saved_files = list((Path(_TMP) / ".search_fetchres").glob("*.pdf")) \
            if (Path(_TMP) / ".search_fetchres").is_dir() else []
        check("nothing written to .search_fetchres", saved_files == [])
    finally:
        docparse._urlopen = saved_open
        os.chdir(cwd)


def test_run_fetch_and_cli():
    print("── fetch entry point + CLI contract")
    from search_fetch import browser, cli, docparse, fetch, media

    tripped = []

    async def _no_connect():
        tripped.append("browser")
        raise AssertionError("browser must not start for a refused URL")

    def _no_media(*a, **k):
        tripped.append("media")
        raise AssertionError("media path must not run for a refused URL")

    def _no_doc(*a, **k):
        tripped.append("docparse")
        raise AssertionError("docparse must not run for a refused URL")

    saved = (browser._connect, media.fetch_media, fetch._route_document, fetch._render, docparse._urlopen)
    browser._connect, media.fetch_media, fetch._route_document = _no_connect, _no_media, _no_doc
    cwd = os.getcwd()
    os.chdir(_TMP)
    try:
        with fake_dns():
            for u in ("file:///etc/passwd", "file:///home/u/.ssh/id_rsa.pdf",
                      "http://127.0.0.1:9522/json/version", "http://[::1]/x.mp4",
                      "https://youtube.com.localhost/watch?v=1"):
                check(f"run_fetch refuses {u}",
                      _raises(lambda u=u: asyncio.run(fetch.run_fetch(u)), url_guard.BlockedURL))
            check("nothing downstream ran (browser/media/docparse)", tripped == [])

            # CLI: refused URL → rc 1, empty stdout, reason on stderr — never a traceback.
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = cli.main(["fetch", "--json", "file:///etc/passwd"])
            check("CLI fetch file:// → rc 1", rc == 1)
            check("CLI fetch file:// → nothing on stdout", out.getvalue() == "")
            check("CLI fetch file:// → reason on stderr", "scheme not allowed" in err.getvalue())

            # `--` ends option parsing: a dash-leading URL reaches run_fetch (and the policy)
            # instead of being parsed as a flag — the runner relies on this.
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = cli.main(["fetch", "--query=--sync", "--", "--json"])   # = fetch_args() shape
            check("CLI `--` separator: dash-leading URL is a URL, not a flag",
                  rc == 1 and "scheme not allowed" in err.getvalue())

            # Browser redirect to a LAN address: refused AFTER render, nothing emitted/saved.
            async def _fake_connect():
                return object()

            async def _fake_render(br, url):
                return None, "<h1>router admin</h1>", {}, "http://192.168.77.1/admin"

            def _no_net(req, timeout=None):
                raise OSError("network disabled in tests")

            browser._connect, fetch._render, docparse._urlopen = _fake_connect, _fake_render, _no_net
            fetch._route_document = saved[2]
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                raised = _raises(lambda: asyncio.run(fetch.run_fetch(f"http://{PUBLIC_IP}/start")),
                                 url_guard.BlockedURL)
            check("render that redirected to LAN is refused", raised)
            check("…and nothing was emitted", "router admin" not in out.getvalue())
            res = Path(_TMP) / ".search_fetchres"
            check("…and nothing was saved",
                  not res.is_dir() or not any("192.168" in p.name or p.name.endswith("_raw.md")
                                              for p in res.iterdir()))
    finally:
        (browser._connect, media.fetch_media, fetch._route_document, fetch._render,
         docparse._urlopen) = saved
        os.chdir(cwd)


def test_search_dash_query():
    print("── search: dash-leading query after `--`")
    from search_fetch import browser, cli, config
    from search_fetch import search as search_mod
    seen = {}

    async def _fake_connect():
        return object()

    async def _fake_search(q, eng, pages, lang=None, region=None, br=None, fresh=None):
        seen.update(q=q, eng=eng, lang=lang, fresh=fresh)
        return [], None

    saved = (browser._connect, search_mod.search, dict(config.ENGINES))
    browser._connect, search_mod.search = _fake_connect, _fake_search
    config.ENGINES["fixture"] = lambda lang, region: "http://x"
    cwd = os.getcwd()
    os.chdir(_TMP)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            # Argv shape with option-like query text after the separator, as WriterAgent's sfSearchArgs builds it.
            rc = cli.main(["search", "--engine=fixture", "--pages=1", "--json",
                           "--fresh=week", "--lang=-en", "--", "-site:example.org 报告"])
        check("search rc 0", rc == 0)
        check("dash-leading query preserved", seen.get("q") == "-site:example.org 报告")
        check("--lang=<dash value> preserved", seen.get("lang") == "-en")
        check("--fresh=<value> parsed", seen.get("fresh") == "week")
    finally:
        browser._connect, search_mod.search = saved[0], saved[1]
        config.ENGINES.clear()
        config.ENGINES.update(saved[2])
        os.chdir(cwd)


def test_ingest_argv():
    print("── ingest: runner argv shape (`--json -- <dir>`)")
    import json

    from search_fetch import cli
    d = Path(_TMP) / "-参考资料"          # dash-leading name: must stay positional
    d.mkdir()
    (d / "note.txt").write_text("访谈记录：本地材料。", encoding="utf-8")
    cwd = os.getcwd()
    os.chdir(_TMP)
    try:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = cli.main(["ingest", "--json", "--", "-参考资料"])
        rep = json.loads(out.getvalue() or "{}")
        check("ingest rc 0 with `--` + dash-leading dir", rc == 0)
        check("ingest parsed the file", [f["status"] for f in rep.get("files", [])] == ["ok"])
    finally:
        os.chdir(cwd)


def run() -> bool:
    # Private state (pacing slots of the guarded downloads) goes to the temp dir, never the real HOME.
    config.HOME = Path(_TMP) / "home"
    try:
        test_schemes()
        test_addresses()
        test_names()
        test_browser_parser_agreement()
        test_resolution_guard()
        test_allow_private()
        test_final_url()
        test_redirect_handler_unit()
        test_redirect_end_to_end()
        test_dns_rebinding_pinned()
        test_docparse_paths()
        test_page_doc_harvest()
        test_run_fetch_and_cli()
        test_search_dash_query()
        test_ingest_argv()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    print("\nURL GUARD:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    return _fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
