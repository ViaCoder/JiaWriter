"""search_fetch.fetch — render a URL and turn the final page into markdown.

Deterministic and model-free: only a suspicious/empty page gets ONE extra
challenge check (_still_blocked). Media URLs (YouTube / audio / video) route to
search_fetch.media; document URLs (pdf/docx/…) route to search_fetch.docparse.
OCR and ASR run as BACKGROUND tasks (search_fetch.tasks) on the CLI path so
they never block further searching/fetching; --sync runs them
inline (its caller needs the content in the reply).
"""

# Blocking work runs in threads.
import asyncio

# The machine contract.
import json

# Publication dates.
import re

# stdout.
import sys

# Harvest budget.
import time

# Plausibility of publication years.
from datetime import date

# Writers, browser, knobs, parsing, rendering, media, tasks and both URL policies.
from . import artifacts, browser, config, docparse, filters, known_urls, markdown, media, tasks, url_guard

# Shared stderr logger.
from .config import _log


def _doc_suffix(doc: dict, url: str) -> str:
    """File extension for a parsed document's original binary."""
    # From the detected kind and the final URL.
    return docparse.doc_suffix(doc["meta"]["kind"], doc["final_url"] or url)


def _enqueue_ocr(doc: dict, url: str, bin_path) -> str:
    """Start the background OCR task of a document whose binary is saved at bin_path; return the task id."""
    # The worker reads the saved binary.
    return tasks.enqueue("ocr", {"bin": str(bin_path), "kind": doc["meta"]["kind"],
                                 "suffix": _doc_suffix(doc, url), "source": doc["final_url"] or url})


def _grab_page_docs(html: str, final_url: str, defer: bool = False) -> list:
    """Browser-path bonus: download + parse the documents (pdf/docx/…) LINKED on the fetched
    page, capped at config.PAGE_DOCS_MAX. Sure links (document extension) are taken as-is; if the
    cap has room, extensionless links that HINT at a document (…/pdf/…, /download?id=…) are
    header-sniffed first and taken only when the server confirms. Each document's ORIGINAL
    binary is saved to disk next to its parsed text (both indexed), so the LLM reader — or
    the user — can open either. Sync (urllib inside docparse); run via asyncio.to_thread.
    Never raises past a doc. The whole harvest runs under config.PAGE_DOCS_BUDGET wall-clock —
    slow document servers must not push the fetch past the Rust runner's hard-kill."""
    # Absolute end of the harvest.
    deadline = time.monotonic() + config.PAGE_DOCS_BUDGET
    # Links with a document extension.
    links = docparse.extract_document_links(html, final_url, config.PAGE_DOCS_MAX)
    # Room left: sniff links that only hint at a document.
    if len(links) < config.PAGE_DOCS_MAX:
        for u in docparse.extract_document_hints(html, final_url, config.PAGE_DOCS_MAX * 2):
            # Cap reached.
            if len(links) >= config.PAGE_DOCS_MAX:
                break
            # Budget spent.
            if time.monotonic() >= deadline:
                _log("page docs: budget exhausted during hint sniffs — skipping the rest")
                break
            # Taken only when the server confirms a document.
            if u not in links and docparse.sniff_remote_kind(u):
                links.append(u)
    # One row per saved document.
    rows = []
    # Download each link within the budget.
    for i, u in enumerate(links):
        # Budget spent: skip the rest.
        if time.monotonic() >= deadline:
            _log(f"page docs: budget {config.PAGE_DOCS_BUDGET:.0f}s exhausted — skipping {len(links) - i} remaining link(s)")
            break
        # One failing document costs only itself.
        try:
            doc = docparse.try_fetch_document(u, assume_doc=True, keep_bytes=True, defer_ocr=defer)
        except Exception as ex:
            _log(f"page doc failed {u}: {ex}")
            continue
        # Not a document after all.
        if not doc:
            continue
        # The original binary next to the parsed text.
        bin_path = artifacts._save_binary(doc["final_url"] or u, _doc_suffix(doc, u), doc.pop("data", b""))
        # OCR deferred to a background task, which needs the saved binary.
        if doc.get("needs_task"):
            # Without the binary there is nothing to OCR.
            if bin_path is None:
                _log(f"page doc {u}: OCR needed but the binary could not be saved — skipped")
                continue
            # Start the task.
            tid = _enqueue_ocr(doc, u, bin_path)
            # Ledger row.
            artifacts._append_index("doc-ocr", u, [bin_path], final_url)
            # Record without text yet.
            rows.append({"url": doc["final_url"], "kind": doc["meta"]["kind"], "chars": 0, "file": str(bin_path), "task": tid})
            _log(f"page doc {doc['meta']['kind']}: {u} → OCR task {tid}")
            continue
        # Parsed text as a page.
        fit, _ = artifacts._save_results(u, doc["final_url"], {"fit": doc["text"], "raw": doc["text"]}, {"docparse": doc["meta"]})
        # Ledger row with both files.
        artifacts._append_index("doc", u, [p for p in (bin_path, fit) if p], final_url)
        # Record.
        rows.append({"url": doc["final_url"], "kind": doc["meta"]["kind"], "chars": doc["meta"]["chars"], "file": str(bin_path or fit)})
        _log(f"page doc {doc['meta']['kind']}: {u} → {(bin_path or fit).name}")
    # All saved documents.
    return rows


# ── Fetch path (deterministic; one extra check when a page looks blocked) ──

# Year-month-day in ISO, slash, dot or 年月日 form.
_PUB_DATE_RE = re.compile(r"(20\d{2})[-/年.](1[0-2]|0?[1-9])[-/月.](3[01]|[12]\d|0?[1-9])")


def _pub_iso(meta: dict) -> str:
    """The page's publication date as YYYY-MM-DD, or ''. Parsed from the ops/meta.js `pub`
    field (article:published_time / meta date / <time datetime>) — ISO timestamps and
    Chinese 年月日 forms both match. Implausible values (before 2000, after next year)
    are dropped rather than poisoning the recency signal."""
    # First date in the field.
    m = _PUB_DATE_RE.search(str(meta.get("pub") or ""))
    # None declared.
    if not m:
        return ""
    # Plausible years only.
    y = int(m.group(1))
    if not (2000 <= y <= date.today().year + 1):
        return ""
    # Zero-padded ISO date.
    return f"{y}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


async def _still_blocked(page, url: str) -> str:
    """'' when a page that still looks like a challenge turns out to be content; otherwise the wall kind."""
    # Full observation.
    obs = await browser._observe(page)
    # The heuristic no longer fires: content after all.
    if not browser._looks_challenged(obs):
        return ""
    # An explicit challenge iframe that survived the whole budget is definitive (no model call).
    if obs.get("challengeIframe"):
        return "captcha"
    # Phrase-only signal on a short page: counted as content, so a terse real page is never lost.
    # Model hook: a model classification of such a page would go here (see browser.py "Model hook").
    return ""

async def _render(br, url):
    """Open url, wait (bounded, ADAPTIVE), return (page, html, meta, final_url).
    browser._await_content distinguishes the page states and budgets each one separately:
    real content is grabbed the moment it is stable; an anti-bot wall gets up to
    config.FETCH_CHALLENGE_WAIT to clear (Turnstile auto-clears take 5–30s; a human may also
    solve it in the open headed window) — the page is NEVER closed mid-challenge before that
    budget. Only a page that is STILL a challenge afterwards is reported via
    RuntimeError('blocked:…') so the caller moves on instead of hanging."""
    # Paced navigation in a new tab of the user's Chrome.
    page = await browser._open(br, url)
    # The tab is always closed, blocked or not.
    try:
        # Load.
        await browser._ready(page)
        # Adaptive wait for content or a cleared challenge.
        verdict, _probe_obs = await browser._await_content(page, url)
        # Still walled after the full challenge budget.
        if verdict == "challenge":
            wall = await _still_blocked(page, url)
            if wall:
                raise RuntimeError(f"blocked: {url} is behind a {wall} wall (no content fetched)")
        # Rendered HTML.
        html = await page.get_content()
        # Metadata ({} when the script fails).
        try:
            meta = json.loads(await page.run("meta"))
        except Exception:
            meta = {}
        # Where the browser ended up.
        final_url = meta.get("final_url") or url
        _log(f"rendered {len(html)}B HTML — {(page.title or '')!r}")
        # Brief human-like dwell before closing (shorter than search pages: many articles are opened).
        await browser._dwell(page, config.FETCH_DWELL)
        # The rendered page.
        return page, html, meta, final_url
    finally:
        # Close the tab so tabs never pile up.
        await browser._close_page(page)


# ── CLI fetch orchestration (the Rust runner's `fetch` subcommand) ───

def _emit(payload: str):
    """Write to stdout immediately (the runner reads stdout even when it kills the process later)."""
    # Text.
    sys.stdout.write(payload)
    # No buffering delay.
    sys.stdout.flush()


def _emit_page(payload: dict, as_json: bool):
    """Emit {final_url, markdown} as JSON, or the markdown alone."""
    # The two contract fields only.
    _emit(json.dumps({"final_url": payload["final_url"], "markdown": payload["markdown"]}, ensure_ascii=False)
          if as_json else payload["markdown"])


def _route_document(url: str, defer_ocr: bool):
    """Document routing for the CLI path: extension → direct; extensionless →
    header sniff. Returns (doc_dict_or_None, attempted): `attempted` is True when
    docparse FULLY tried this URL (downloaded/parsed/OCR'd) — the browser path's
    DOC_RESCUE must then not repeat the whole pipeline on an OCR-empty result."""
    # A document extension: parse directly.
    if docparse.looks_like_document(url):
        return docparse.try_fetch_document(url, defer_ocr=defer_ocr, keep_bytes=True), True
    # Extensionless but worth a header sniff, and the server confirms a document.
    if docparse.worth_sniffing(url) and docparse.sniff_remote_kind(url):
        return docparse.try_fetch_document(url, assume_doc=True, defer_ocr=defer_ocr, keep_bytes=True), True
    # A web page.
    return None, False


def _finish_doc(requested_url: str, doc: dict) -> dict:
    """Persist a parsed document — or, when its OCR was deferred (needs_task), save
    the binary + enqueue the background OCR task — and return {final_url, markdown}."""
    # Where the document ended up.
    final = doc["final_url"]
    # The original binary (pdf/docx/…) beside the parsed text when it was kept, so the user can open the source itself.
    data = doc.get("data")
    bin_path = artifacts._save_binary(final or requested_url, _doc_suffix(doc, requested_url), data) if data else None
    # OCR deferred to a background task.
    if doc.get("needs_task"):
        # The task needs the saved binary.
        if bin_path is None:
            raise RuntimeError(f"{requested_url}: OCR needed but the document could not be saved")
        # Start it.
        tid = _enqueue_ocr(doc, requested_url, bin_path)
        # Ledger row.
        artifacts._append_index("doc-ocr", requested_url, [bin_path], final)
        _log(f"docparse {doc['meta']['kind']}: OCR deferred → background task {tid}")
        # A receipt instead of text.
        note = (f"[OCR running in background: task {tid} — {doc['meta']['kind']} saved as "
                f"{bin_path.name}; the text joins the knowledge base after `tasks wait`]")
        return {"final_url": final, "markdown": note, "task": tid}
    # Parsed text as a page.
    fit, raw = artifacts._save_results(requested_url, final, {"fit": doc["text"], "raw": doc["text"]},
                                       {"final_url": final, "docparse": doc["meta"]})
    # Ledger row with every saved file.
    artifacts._append_index("fetch", requested_url, [p for p in (fit, raw, bin_path) if p], final)
    _log(f"docparse {doc['meta']['kind']} → {doc['meta']['chars']}B{' (OCR)' if doc['meta'].get('ocr_used') else ''}")
    # Bounded body.
    return {"final_url": final, "markdown": markdown._clamp_chars(doc["text"], config.FETCH_MAX_CHARS)}


def _page_markdown(html: str, final: str, query: str) -> dict:
    """Markdown of a rendered page: the two-pass BM25 filter with a query, generic pruning otherwise."""
    # With a query: prune first, then BM25 (filters.bm25_fit).
    if query:
        try:
            return filters.bm25_fit(html, final, query)
        except Exception as ex:
            _log(f"BM25 filter unavailable ({ex}); falling back to pruning")
    # Generic pruning filter.
    return markdown._html_to_markdown(html, final)


def _page_body(md: dict, meta: dict) -> str:
    """The emitted body: filtered text (raw when filtering ate the page), the publication date first, bounded."""
    # Filtered text, or raw when the filter kept nothing.
    body_md = md["fit"] or md["raw"]
    # A real BM25 match may be short; a de-noised page that collapsed to nothing means the pruner ate content.
    if not md.get("matched", False) and len(body_md) < config.DOC_RESCUE_CHARS:
        _log(f"de-noised page only {len(body_md)}B — emitting raw page {len(md['raw'])}B instead")
        body_md = md["raw"]
    # The declared publication date opens the body: it tells the reader how fresh the source is and gives kb.py the page date.
    pub = _pub_iso(meta)
    if pub:
        body_md = f"（发布时间：{pub}）\n\n{body_md}"
    # Bounded.
    return markdown._clamp_chars(body_md, config.FETCH_MAX_CHARS)


async def run_fetch(url: str, query: str = None, as_json: bool = False, defer: bool = True):
    """The `fetch` subcommand — ONE decision ladder: media → document → browser.

    `defer=True` (the CLI/research contract) backgrounds OCR and ASR so they never
    block further searching/fetching; the fetch returns immediately with a task
    receipt and the KB barrier (`sf.py tasks wait`) collects the text later.
    `sf.py fetch --sync` calls the same pieces with defer=False (its caller needs the
    content in the reply, bounded by the per-call deadlines)."""
    # 0. Outbound policy FIRST — the URL comes from an LLM that reads untrusted pages: http(s) only,
    #    public addresses only unless SEARCH_FETCH_ALLOW_PRIVATE=1. Raises → `failed: …`, rc 1.
    url_guard.check_url(url)
    # Opt-in (SEARCH_FETCH_ONLY_KNOWN_URLS=1): only URLs this run's searches / KB sources produced;
    # may drop an unregistered #fragment.
    url = known_urls.check(url)
    # 1. Media (YouTube / direct audio-video): subtitles inline, else metadata + background ASR.
    kind = media.classify_url(url)
    if kind:
        _emit_page(await asyncio.to_thread(media.fetch_media, url, kind, defer), as_json)
        return
    # 2. Documents: extension → direct; extensionless → header sniff (no body download).
    doc, doc_attempted = None, False
    try:
        doc, doc_attempted = await asyncio.to_thread(_route_document, url, defer)
    except Exception as ex:
        _log(f"docparse skipped ({ex}); using browser")
    if doc:
        _emit_page(_finish_doc(url, doc), as_json)
        return
    # 3. Browser render.
    br = await browser._connect()
    _, html, meta, final = await _render(br, url)
    # The browser follows redirects itself: a public URL that bounced to a LAN/loopback address is refused.
    url_guard.check_final_url(final)
    # Markdown of the page.
    md = _page_markdown(html, final, query)
    # (Near-)empty render — typically an attachment the browser cannot display: one forced docparse look,
    # skipped when docparse already fully tried this URL.
    if len((md["raw"] or "").strip()) < config.DOC_RESCUE_CHARS and not doc_attempted:
        rescue = None
        try:
            rescue = await asyncio.to_thread(docparse.try_fetch_document, url, assume_doc=True, defer_ocr=defer)
        except Exception as ex:
            _log(f"doc rescue failed: {ex}")
        if rescue:
            _emit_page(_finish_doc(url, rescue), as_json)
            return
    # Full page to disk.
    fit, raw = artifacts._save_results(url, final, md, meta)
    # Ledger row.
    artifacts._append_index("fetch", url, [fit, raw], final)
    # What reaches the caller's corpus.
    body = _page_body(md, meta)
    # Plain mode emits the body BEFORE the document harvest: a slow linked-document server must never cost
    # the rendered content (the runner kills at its deadline and treats empty stdout as failure).
    if not as_json:
        _emit(body)
    # Bonus: the documents this page links to.
    docs = []
    if config.PAGE_DOCS_MAX > 0:
        try:
            docs = await asyncio.to_thread(_grab_page_docs, html, final, defer)
        except Exception as ex:
            _log(f"page-doc grab failed: {ex}")
    # List of downloaded documents.
    trailer = ""
    if docs:
        trailer = "\n\n## Documents downloaded from this page\n" + "\n".join(
            f"- {d['url']} ({d['kind']}, {d['chars']} chars parsed) → {d['file']}" for d in docs)
    # JSON mode emits once, with the documents.
    if as_json:
        payload = {"final_url": final, "markdown": body + trailer}
        if docs:
            payload["documents"] = docs
        _emit(json.dumps(payload, ensure_ascii=False))
    else:
        # Plain mode appends the list.
        _emit(trailer)
