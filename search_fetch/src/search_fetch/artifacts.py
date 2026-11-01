"""search_fetch.artifacts — everything written to ./.search_fetchres/.

Slugs, the artifact index ledger, fit/raw page saves, SERP saves, the machine
JSON contract for the Rust runner, and the per-search ops trace. Whole-file writes
are atomic (temp file + fsync + rename), so a crash never leaves half a file.
"""

# Ignoring cleanup errors.
import contextlib

# Short stable suffixes for file names.
import hashlib

# The machine contract and the ops trace.
import json

# Atomic replace and fsync.
import os

# Slug cleaning.
import re

# Temp files next to the target.
import tempfile

# Host and path of a URL.
import urllib.parse

# Timestamps.
from datetime import datetime

# Path arithmetic.
from pathlib import Path

# Results directory name.
from . import config

# Header of a new artifact index.
_INDEX_HEADER = ("# search_fetch artifacts\n\n"
                 "| Time | Type | Subject/URL | File | Source |\n"
                 "|---|---|---|---|---|\n")


# ── Output helpers ──────────────────────────────────────────────────

def _slug(url: str) -> str:
    """File-name stem for a URL: cleaned host+path (≤80 chars) plus a 6-hex hash of the URL."""
    # Host and path.
    p = urllib.parse.urlparse(url)
    # Without slashes at the ends; "page" for an empty path.
    base = (p.netloc + p.path).strip("/") or "page"
    # Only file-name-safe characters, bounded length.
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-")[:80] or "page"
    # The hash keeps different URLs with the same cleaned form apart.
    return f"{base}_{hashlib.md5(url.encode('utf-8')).hexdigest()[:6]}"


def _query_slug(q: str) -> str:
    """File-name stem for a search query: ASCII words (≤60 chars) plus a 6-hex hash."""
    # ASCII words only; "query" for a purely non-ASCII query.
    base = re.sub(r"[^A-Za-z0-9]+", "-", q).strip("-").lower()[:60] or "query"
    # The hash distinguishes queries (Chinese queries all clean to "query").
    return f"{base}_{hashlib.md5(q.encode('utf-8')).hexdigest()[:6]}"


def _outdir() -> Path:
    """./.search_fetchres in the current directory, created on demand."""
    # Results live next to the work folder the runner starts sf in.
    d = Path.cwd() / config.RESULTS_DIRNAME
    # Create it (and its parents) once.
    d.mkdir(parents=True, exist_ok=True)
    # The directory.
    return d


def _write_atomic(path: Path, data) -> None:
    """Write text (str) or bytes to path atomically: a temp file in the same directory, fsync, then rename."""
    # Same directory, so the rename never crosses file systems.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    # Write, flush to disk, then move into place.
    try:
        # Binary for bytes, UTF-8 text for str.
        with (os.fdopen(fd, "wb") if isinstance(data, bytes) else os.fdopen(fd, "w", encoding="utf-8")) as f:
            # Content.
            f.write(data)
            # Push Python's buffer to the OS.
            f.flush()
            # And the OS buffer to disk.
            os.fsync(f.fileno())
        # Atomic on POSIX and Windows.
        os.replace(tmp, path)
    except BaseException:
        # Never leave the temp file behind.
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        # Report the original failure.
        raise


def _save_binary(url: str, suffix: str, data: bytes):
    """Save a downloaded original (pdf/docx/…) as <slug of url><suffix>; return its path, or None when it cannot be written."""
    # Same stem as the page files of that URL.
    path = (_outdir() / f"{_slug(url)}{suffix}").resolve()
    # A disk error costs only the original copy, never the parsed text.
    try:
        _write_atomic(path, data or b"")
    except OSError as ex:
        config._log(f"original save failed {path.name}: {ex}")
        return None
    # The path.
    return path


def _append_index(kind: str, subject: str, files, source: str = ""):
    """Append one row to ./.search_fetchres/index.md (header created exactly once)."""
    # A single file is accepted too.
    if isinstance(files, (str, Path)):
        files = [files]
    # File names only, comma-separated.
    paths = ", ".join(Path(f).name for f in files if f)
    # The ledger.
    idx = _outdir() / "index.md"
    # Exclusive create: of several concurrent fetch processes only one writes the header.
    try:
        with idx.open("x", encoding="utf-8") as f:
            f.write(_INDEX_HEADER)
    except FileExistsError:
        pass
    # Row time.
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    # Appends of one short line are not interleaved by the OS.
    with idx.open("a", encoding="utf-8") as f:
        # "|" would break the table, so it becomes "/"; long cells are cut.
        f.write(f"| {ts} | {kind} | {(subject or '').replace('|', '/')[:140]} | "
                f"{paths} | {(source or '').replace('|', '/')[:140]} |\n")


def _page_header(requested_url: str, final_url: str, meta: dict) -> str:
    """HTML-comment header of a saved page: source, final URL, title/pub/lang and description."""
    # Where the page was requested from.
    header = f"<!-- source: {requested_url} -->\n"
    # Where it ended up after redirects.
    if final_url and final_url != requested_url:
        header += f"<!-- final_url: {final_url} -->\n"
    # Page metadata that is present.
    mline = "; ".join(f"{k}={meta[k]}" for k in ("title", "pub", "lang") if meta.get(k))
    # One meta line.
    if mline:
        header += f"<!-- meta: {mline} -->\n"
    # The description as a quote.
    if meta.get("desc"):
        header += f"\n> {meta['desc']}\n"
    # Blank line before the body.
    return header + "\n"


def _save_results(requested_url: str, final_url: str, result: dict, meta: dict = None):
    """Save a page as <slug>_fit.md (filtered, or raw when empty) and <slug>_raw.md; return both paths."""
    # Directory, file stem and metadata.
    outdir, slug, meta = _outdir(), _slug(final_url or requested_url), (meta or {})
    # Shared header.
    header = _page_header(requested_url, final_url, meta)
    # Filtered version.
    fit_path = (outdir / f"{slug}_fit.md").resolve()
    # Full version.
    raw_path = (outdir / f"{slug}_raw.md").resolve()
    # The filtered copy falls back to raw when the filter kept nothing.
    _write_atomic(fit_path, header + (result["fit"] or result["raw"]))
    # The full copy.
    _write_atomic(raw_path, header + result["raw"])
    # Both paths.
    return fit_path, raw_path


def _format_blocks(query: str, blocks: list) -> str:
    """Human-readable SERP file: one section per engine page with its markdown."""
    # Title and count.
    out = [f"# Search markdown — {query}",
           f"_{len(blocks)} result page(s), crawl4ai markdown (no custom parsing)_", ""]
    # One section per block.
    for b in blocks:
        # Optional language tag.
        lang = f"/{b['lang']}" if b.get("lang") else ""
        # Section separator naming engine, page and URL.
        out.append(f"\n===== {b['engine']}{lang} · page {b['page']} · {b['url']} =====\n")
        # The page markdown.
        out.append(b.get("markdown", ""))
    # One text with a final newline.
    return "\n".join(out) + "\n"


def _blocks_json(query: str, blocks: list) -> str:
    """Structured search result for a machine consumer (the Rust runner): clean DOM
    hrefs (`results`) + the page markdown, so the caller never has to RE-SCRAPE urls out
    of markdown (which captured truncated display strings like '…6天前'). The `results`
    links are real anchors pulled from the SERP DOM by `_serp_results`."""
    # The JSON contract.
    return json.dumps({
        "query": query,
        "blocks": [{
            "engine": b.get("engine", ""),
            "page": b.get("page", 0),
            "url": b.get("url", ""),
            # [{u: href, t: title}].
            "results": b.get("results", []),
            "markdown": b.get("markdown", ""),
        } for b in blocks],
    }, ensure_ascii=False)


def _save_search(query: str, blocks: list, ops_path) -> Path:
    """Save the SERP file search-<slug>.md (atomically) and return its path."""
    # File path.
    path = (_outdir() / f"search-{_query_slug(query)}.md").resolve()
    # Name of the matching ops trace.
    ops_name = ops_path.name if ops_path else "-"
    # Header comments plus the formatted blocks.
    _write_atomic(path, f"<!-- query: {query} -->\n<!-- ops: {ops_name} -->\n\n" + _format_blocks(query, blocks))
    # The path.
    return path


def _save_empty_serp(ops_path, engine: str, page_no: int, url: str, markdown: str):
    """Keep a results page that yielded no result links (blocked, redesigned or truly empty) next to
    the ops trace as search-<slug>.<engine>-p<n>-empty.md, so the cause can be read without another
    visit; returns its path, or None without a trace."""
    # Saved only alongside a trace.
    if not ops_path:
        return None
    # search-<slug>.ops.jsonl → search-<slug>.<engine>-p<n>-empty.md
    ops_path = Path(ops_path)
    path = ops_path.with_name(f"{ops_path.name.removesuffix('.ops.jsonl')}.{engine}-p{page_no}-empty.md")
    # Address header plus the page as rendered.
    _write_atomic(path, f"<!-- url: {url} -->\n\n{markdown}")
    # The path.
    return path


def _trace(path, data: dict):
    """Append one timestamped JSON record to an ops trace (no-op without a path)."""
    # Tracing is optional.
    if not path:
        return
    # Record with the time.
    rec = dict(data, time=datetime.now().isoformat(timespec="seconds"))
    # One JSON line.
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
