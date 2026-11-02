#!/usr/bin/env python3
"""docparse.py — turn a fetched document (pdf/docx/pptx/xlsx/csv) into text.

Ships next to engine.py (sibling, like kb.py/filters.py). engine.py's `fetch` command
routes document URLs here instead of the headed browser, which returns empty markdown for
binaries (the earlier `[research] fetch FAIL/empty: …report.pdf` cases).

Text extraction uses the SAME libraries the vendored MiniMax skills use:
    pdf        -> pypdf.extract_text()      (vendor/skills/minimax-pdf)
    xlsx/xlsm  -> openpyxl                   (vendor/skills/minimax-xlsx)
    pptx/docx  -> markitdown                 (vendor/skills/pptx-generator)
    csv/tsv    -> plain decode

There is no OCR: images and scanned (image-only) PDFs carry no text layer, so they
yield no text and the caller treats them like any document without text.

Env knobs (all optional):
    SEARCH_FETCH_DOC_HTTP_TIMEOUT  seconds    (default 60)  — per-document http download timeout
    SEARCH_FETCH_DOC_MAX_MB     int           (default 40)  — per-document download cap
"""
import html as _htmllib
import io
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request

try:
    # Per-host request pacing shared by all sf processes, and the package home.
    from . import config, pacing, url_guard
except ImportError:   # run as a standalone script: docparse.py <file-or-url>
    import url_guard
    # A one-off standalone run is not paced and uses the system temp directory.
    config = pacing = None

# ── config ──────────────────────────────────────────────────────────
# Renamed from SEARCH_FETCH_FETCH_TIMEOUT, which COLLIDED with the Rust runner's whole-fetch
# hard-kill env of the same name — an operator setting the documented download semantics (60)
# would silently make the runner kill every challenge-waiting fetch.
HTTP_TIMEOUT  = float(os.environ.get("SEARCH_FETCH_DOC_HTTP_TIMEOUT", "60"))
SNIFF_TIMEOUT = min(HTTP_TIMEOUT, 15.0)   # type sniff is a header round-trip, not a download
DOC_MAX_BYTES = int(os.environ.get("SEARCH_FETCH_DOC_MAX_MB", "40")) * 1024 * 1024
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/149.0.0.0 Safari/537.36")
# Full browser header set so bot-protected sites (news, .gov, congress) don't 403 the type
# sniff / document download the way a bare urllib request gets rejected. Accept-Encoding stays
# "identity": the ranged sniff reads raw magic bytes (%PDF-/PK…) and _http_get reads raw doc
# bytes, and urllib does NOT auto-decompress — a gzip/br body would corrupt both.
_BROWSER_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
}

DOC_EXTS = {".pdf", ".docx", ".pptx", ".xlsx", ".xlsm", ".csv", ".tsv"}
IMG_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"}
# Extensions the browser owns outright — never worth a remote type sniff.
HTMLISH_EXTS = {".html", ".htm", ".xhtml", ".shtml", ".php", ".asp", ".aspx", ".jsp",
                ".jspx", ".cgi", ".txt", ".md", ".xml", ".json", ".rss", ".atom"}

_CT_KIND = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xlsx",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
}
_EXT_KIND = {".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".xlsx": "xlsx",
             ".xlsm": "xlsx", ".csv": "csv", ".tsv": "tsv"}


def _log(msg: str):
    sys.stderr.write(f"[docparse] {msg}\n")
    sys.stderr.flush()


# ── url helpers ─────────────────────────────────────────────────────
def _scratch():
    """Directory for temp files that hold document contents: <HOME>/tmp in package mode
    (all state stays inside the package), None (the system temp dir) when run standalone."""
    # Standalone script.
    if config is None:
        return None
    # Inside the package home.
    d = config.HOME / "tmp"
    # Create it once.
    d.mkdir(parents=True, exist_ok=True)
    # As a string for tempfile.
    return str(d)


def _host_is(host: str, domain: str) -> bool:
    """`host` is `domain` itself or one of its subdomains (label-aligned match)."""
    return host == domain or host.endswith("." + domain)


def _unwrap(url: str) -> str:
    """Decode common SERP redirect wrappers to the real target (so a duckduckgo /l/?uddg=…
    or google /url?q=… link that points at a .pdf is recognised as a document)."""
    try:
        p = urllib.parse.urlparse(url)
        q = urllib.parse.parse_qs(p.query)
        # EXACT host (or a real subdomain): a suffix match let `evilgoogle.com/url?q=…`
        # pass as a wrapper — and known_urls treats an unwrapped target as the URL's
        # identity, so a look-alike host could carry data to an attacker server.
        host = (p.hostname or "").rstrip(".")
        if _host_is(host, "duckduckgo.com") and p.path.startswith("/l/") and q.get("uddg"):
            return urllib.parse.unquote(q["uddg"][0])
        if _host_is(host, "google.com") and p.path in ("/url", "/imgres"):
            for k in ("q", "url", "imgurl"):
                if q.get(k):
                    return q[k][0]
    except Exception:
        pass
    return url


def _ext(url: str) -> str:
    path = urllib.parse.urlparse(url).path.lower()
    base = path.rsplit("/", 1)[-1]   # a dot in a DIRECTORY segment is not an extension
    dot = base.rfind(".")
    return base[dot:] if dot != -1 else ""


def looks_like_document(url: str) -> bool:
    """True if the (redirect-unwrapped) URL clearly points at a document/image by extension.
    Extension-gated on purpose: HTML URLs (no/html extension) fall through to the browser,
    so normal page fetches are never double-downloaded."""
    return _ext(_unwrap(url)) in (DOC_EXTS | IMG_EXTS)


def worth_sniffing(url: str) -> bool:
    """Extensionless (or unknown-extension) URL: only the server can say whether it is a
    document (…/download?id=7 style links). Known page extensions skip the sniff so an
    ordinary fetch pays zero overhead; known document extensions take the direct path."""
    return _ext(_unwrap(url)) not in (HTMLISH_EXTS | DOC_EXTS | IMG_EXTS)


_HREF_RE = re.compile(r"""(?:href|src)\s*=\s*["']([^"'<>\s#]+)""", re.I)


def _iter_page_links(html: str, base_url: str):
    """href/src targets of a rendered page → absolute http(s) URLs, redirect-unwrapped,
    in DOM order (duplicates included — callers dedupe)."""
    for href in _HREF_RE.findall(html or ""):
        if href.startswith(("javascript:", "mailto:", "data:", "tel:", "about:")):
            continue
        u = _unwrap(urllib.parse.urljoin(base_url or "", _htmllib.unescape(href)))
        if u.startswith(("http://", "https://")):
            yield u


def extract_document_links(html: str, base_url: str, limit: int = 0) -> list:
    """SURE document urls (DOC_EXTS by extension, after redirect-unwrap) linked from a
    rendered page — <a href>/<iframe src>/<embed src>, resolved against base_url, deduped
    in DOM order, capped at `limit` (0 = no cap). Images are page furniture and excluded."""
    out, seen = [], set()
    for u in _iter_page_links(html, base_url):
        if _ext(u) in DOC_EXTS and u not in seen:
            seen.add(u)
            out.append(u)
            if limit and len(out) >= limit:
                break
    return out


# URL smells like a downloadable document even without a document extension
# (arxiv.org/pdf/1706.03762, /download?id=…, attachment.cgi?…).
_DOC_HINT_RE = re.compile(
    r"(?:^|[/?=&_.-])(?:pdf|docx?|pptx?|xlsx?|download|attachment|getfile|filedown)(?:$|[/?=&_.-])",
    re.I)


def extract_document_hints(html: str, base_url: str, limit: int = 0) -> list:
    """Extensionless page links whose URL HINTS at a document (…/pdf/…, /download?id=…) —
    candidates for a header sniff (sniff_remote_kind) before any download, NOT sure things.
    Page-ish extensions (.php/.aspx…) stay in only when a document token (`.pdf` etc.)
    appears in the URL, e.g. download.php?file=report.pdf."""
    out, seen = [], set()
    for u in _iter_page_links(html, base_url):
        if u in seen:
            continue
        e = _ext(u)
        if e in (DOC_EXTS | IMG_EXTS):
            continue    # sure documents (extract_document_links) / page furniture
        p = urllib.parse.urlparse(u)
        blob = (p.path + "?" + p.query).lower()
        if e in HTMLISH_EXTS and not re.search(r"\.(?:pdf|docx|pptx|xlsx|csv)\b", blob):
            continue
        if _DOC_HINT_RE.search(blob):
            seen.add(u)
            out.append(u)
            if limit and len(out) >= limit:
                break
    return out


def _cd_filename(cd: str) -> str:
    """Filename out of a Content-Disposition header (RFC 5987 filename*= wins).
    The ext-value form is charset'language'value — the language tag is optional
    but the two quotes are not, and the tag may be present (UTF-8'en'report.pdf)."""
    if not cd:
        return ""
    m = re.search(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"?([^";]+)', cd, re.I)
    return m.group(1).strip() if m else ""


# ── http ────────────────────────────────────────────────────────────
def _urlopen(req, timeout=None):
    """THE network open for every docparse request: url_guard's policy (http(s)
    only, public addresses only, re-checked on each redirect hop) — the URLs come
    from an LLM or are harvested out of untrusted pages (file:// would read local
    files, private addresses reach the LAN/loopback). Requests to one host are spaced
    by SEARCH_FETCH_HOST_GAP across every sf process (pacing.py)."""
    # Wait for this host's turn (package mode only).
    if pacing is not None:
        pacing.before_request(req.full_url if isinstance(req, urllib.request.Request) else str(req))
    # Policy-checked open.
    return url_guard.urlopen(req, timeout=timeout)


def _http_get(url: str):
    req = urllib.request.Request(url, headers=dict(_BROWSER_HEADERS))
    with _urlopen(req, timeout=HTTP_TIMEOUT) as r:
        final = r.geturl() or url
        ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        cd = r.headers.get("Content-Disposition") or ""
        cl = r.headers.get("Content-Length")
        if cl and cl.isdigit() and int(cl) > DOC_MAX_BYTES:
            raise RuntimeError(f"document too large ({cl}B > {DOC_MAX_BYTES}B cap)")
        data = r.read(DOC_MAX_BYTES + 1)
        if len(data) > DOC_MAX_BYTES:
            raise RuntimeError(f"document too large (> {DOC_MAX_BYTES}B cap)")
    return data, ct, final, cd


def _zip_kind(data: bytes) -> str:
    """OOXML documents are zips — the top-level folder tells them apart."""
    import zipfile
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
    except Exception:
        return ""
    for prefix, kind in (("word/", "docx"), ("ppt/", "pptx"), ("xl/", "xlsx")):
        if any(n.startswith(prefix) for n in names):
            return kind
    return ""


def _magic_image(data: bytes) -> bool:
    if data.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"II*\x00", b"MM\x00*")):
        return True
    return data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _detect_kind(url: str, ct: str, data: bytes, cd: str = "") -> str:
    """URL extension → Content-Disposition filename → Content-Type → magic bytes.
    An explicit html Content-Type bails out before the magic sniff, so a force-checked
    web page (assume_doc / sniff path) is never misread as a binary."""
    e = _ext(url)
    if e in IMG_EXTS:
        return "image"
    if e in _EXT_KIND:
        return _EXT_KIND[e]
    fe = _ext(_cd_filename(cd))
    if fe in IMG_EXTS:
        return "image"
    if fe in _EXT_KIND:
        return _EXT_KIND[fe]
    if ct in _CT_KIND:
        return _CT_KIND[ct]
    if ct.startswith("image/"):
        return "image"
    if data[:5] == b"%PDF-":
        return "pdf"
    if ct in ("text/html", "application/xhtml+xml"):
        return ""    # a real web page — the browser owns it
    if data[:4] == b"PK\x03\x04":
        return _zip_kind(data)
    if _magic_image(data):
        return "image"
    return ""


def sniff_remote_kind(url: str) -> str:
    """Cheap remote type check for extensionless links: HEAD first, then a small ranged
    GET when HEAD is refused OR inconclusive — classify from Content-Type/-Disposition
    (+ leading bytes on the GET path) WITHOUT downloading the body. A decisive page-ish
    HEAD (text/html…) stops here so ordinary pages never pay a second request; only an
    ambiguous one (application/octet-stream, missing Content-Type) goes on to the GET,
    whose first bytes can still reveal %PDF-/PK magic. '' ⇒ not a recognisable document."""
    target = _unwrap(url)
    try:
        req = urllib.request.Request(target, method="HEAD",
                                     headers=dict(_BROWSER_HEADERS))
        with _urlopen(req, timeout=SNIFF_TIMEOUT) as r:
            ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            cd = r.headers.get("Content-Disposition") or ""
            final = r.geturl() or target
        kind = _detect_kind(final, ct, b"", cd)
        if kind:
            _log(f"sniff HEAD: {kind} ← {target}")
            return kind
        if ct in ("text/html", "application/xhtml+xml") or ct.startswith("text/"):
            return ""   # server is explicit: a web page (text/csv etc. already matched above)
        # inconclusive HEAD (octet-stream / no Content-Type) — magic bytes may still decide
    except Exception:
        pass   # HEAD refused/blocked — fall through to the ranged GET
    try:
        req = urllib.request.Request(target, headers={**_BROWSER_HEADERS, "Range": "bytes=0-4095"})
        with _urlopen(req, timeout=SNIFF_TIMEOUT) as r:
            ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            cd = r.headers.get("Content-Disposition") or ""
            final = r.geturl() or target
            data = r.read(4096)   # servers ignoring Range stream on — read only the head
        kind = _detect_kind(final, ct, data, cd)
        if not kind and data[:4] == b"PK\x03\x04" and \
                ct not in ("text/html", "application/xhtml+xml"):
            # A ranged head of a zip can't reach the central directory (it sits at the END
            # of the file), so _zip_kind can't classify OOXML here. Report a PROBABLE
            # document; the caller's full download runs _zip_kind for real (plain zip ⇒
            # try_fetch_document returns None and the browser path proceeds as before).
            kind = "ooxml?"
        if kind:
            _log(f"sniff GET: {kind} ← {target}")
        return kind
    except Exception as e:
        _log(f"sniff failed for {target}: {str(e)[:100]}")
        return ""


# ── per-format text extraction (mirrors the vendored skills' libraries) ──
def _parse_pdf_text(data: bytes) -> str:
    try:
        import pypdf
    except Exception as e:
        _log(f"pypdf unavailable: {e}")
        return ""
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
    except Exception as e:
        _log(f"pypdf open failed: {e}")
        return ""
    parts = []
    for pg in reader.pages:
        try:
            t = pg.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(t.strip())
    return "\n\n".join(parts).strip()


def _parse_markitdown(data: bytes, suffix: str) -> str:
    try:
        from markitdown import MarkItDown
    except Exception as e:
        _log(f"markitdown unavailable: {e}")
        return ""
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=_scratch()) as f:
            f.write(data)
            path = f.name
        res = MarkItDown().convert(path)
        return (getattr(res, "markdown", None) or getattr(res, "text_content", "") or "").strip()
    except Exception as e:
        _log(f"markitdown convert failed ({suffix}): {e}")
        return ""
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


def _parse_xlsx(data: bytes) -> str:
    try:
        import openpyxl
    except Exception as e:
        _log(f"openpyxl unavailable: {e}")
        return ""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:
        _log(f"openpyxl open failed: {e}")
        return ""
    out = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c) for c in row]
            if any(c.strip() for c in cells):
                rows.append(" | ".join(cells).rstrip(" |"))
        if rows:
            out.append(f"## {ws.title}\n" + "\n".join(rows))
    try:
        wb.close()
    except Exception:
        pass
    return "\n\n".join(out).strip()


def _decode_text(data: bytes) -> str:
    """utf-8 (incl. BOM) first, GBK second — the realistic encodings for local
    Chinese materials. Anything else degrades to utf-8 with replacement.
    (Shared: ingest's .txt/.md path and the CSV/TSV parser below — a GBK 台账
    CSV must not be silently mojibake'd into the corpus with status "ok".)"""
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _parse_csv(data: bytes) -> str:
    return _decode_text(data).strip()


# ── top-level parse ─────────────────────────────────────────────────
def parse_bytes(data: bytes, kind: str) -> dict:
    """Return {'text', 'kind', 'chars'}. Images and scanned PDFs give empty text (no OCR)."""
    # Extracted text ('' when the document has no text layer).
    text = ""
    # PDF text layer.
    if kind == "pdf":
        text = _parse_pdf_text(data)
    # Word and PowerPoint.
    elif kind in ("docx", "pptx"):
        text = _parse_markitdown(data, "." + kind)
    elif kind == "xlsx":
        text = _parse_xlsx(data)
    elif kind in ("csv", "tsv"):
        text = _parse_csv(data)
    # Text, kind and length.
    return {"text": text, "kind": kind, "chars": len(text)}


def doc_suffix(kind: str, url: str = "") -> str:
    """File suffix for saving a downloaded document of `kind` (url ext wins for images)."""
    if kind == "image":
        e = _ext(url)
        return e if e in IMG_EXTS else ".png"
    return {"pdf": ".pdf", "docx": ".docx", "pptx": ".pptx", "xlsx": ".xlsx",
            "csv": ".csv", "tsv": ".tsv"}.get(kind, ".bin")


def try_fetch_document(url: str, assume_doc: bool = False, keep_bytes: bool = False):
    """If `url` (redirect-unwrapped) is a document/image, download + parse it and return
    {'text', 'final_url', 'meta'} (+ 'data' raw bytes when keep_bytes — for saving the
    original file to disk). Return None for anything that should stay on the browser path
    (non-document, download error, or a document that yielded no text). assume_doc skips
    the extension gate — used after a remote sniff said document, or as the last-chance
    rescue when the browser rendered (near-)nothing; header/magic detection still decides."""
    target = _unwrap(url)
    if not assume_doc and _ext(target) not in (DOC_EXTS | IMG_EXTS):
        return None
    try:
        data, ct, final, cd = _http_get(target)
    except Exception as e:
        _log(f"download failed for {target}: {str(e)[:140]}")
        return None
    kind = _detect_kind(final, ct, data, cd)
    if not kind:
        return None
    res = parse_bytes(data, kind)
    # No text layer (an image or a scanned PDF): back to the caller's other paths.
    if not res["text"]:
        _log(f"{kind}: no text layer ← {final}")
        return None
    _log(f"{kind}: {res['chars']}B ← {final}")
    out = {"text": res["text"], "final_url": final, "meta": {"kind": kind, "chars": res["chars"]}}
    if keep_bytes:
        out["data"] = data
    return out


# ── CLI (testing): docparse.py <file-or-url> [--json] ───────────────
def _main(argv):
    if not argv:
        sys.stderr.write("usage: docparse.py <file-or-url> [--json]\n")
        return 2
    as_json = "--json" in argv
    src = [a for a in argv if not a.startswith("--")][0]
    if src.startswith(("http://", "https://")):
        # The CLI target is explicit — skip the extension gate; header/magic detection
        # still decides (an html page comes back "not a document").
        doc = try_fetch_document(src, assume_doc=True)
        if not doc:
            sys.stderr.write("not a document / no text extracted\n")
            return 1
        out = {"final_url": doc["final_url"], "markdown": doc["text"], "meta": doc["meta"]}
    else:
        with open(src, "rb") as f:
            data = f.read()
        e = _ext(src)
        kind = "image" if e in IMG_EXTS else _EXT_KIND.get(e, "")
        if not kind and data[:5] == b"%PDF-":
            kind = "pdf"
        if not kind:
            sys.stderr.write(f"unsupported file type: {e or '(no ext)'}\n")
            return 1
        res = parse_bytes(data, kind)
        out = {"final_url": src, "markdown": res["text"], "meta": {k: res[k] for k in
               ("kind", "chars")}}
    if as_json:
        sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        sys.stdout.write(out["markdown"])
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
