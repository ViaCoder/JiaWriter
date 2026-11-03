"""search_fetch filters — deterministic query-relevance filtering (LLM-free).

There is intentionally NO model call in this module (sf uses no model at all); all
"intelligent" work (extracting facts, synthesising, translating queries) is done by
JiaWriter's writing model, which receives these results and, for large pages, reads the
saved file. This module only makes what JiaWriter receives small and relevant:

  * bm25_fit — query-relevance filtering via crawl4ai's BM25ContentFilter (copied into vendor/crawl4ai)
Length bounding lives in markdown._clamp_chars.
"""

# Knobs (prune threshold) and the markdown renderer.
from . import config, markdown


def _is_ascii(s: str) -> bool:
    """True when s is plain ASCII (the English stemmer is only safe then)."""
    # str.isascii never raises.
    return s.isascii()


def bm25_fit(html: str, url: str, query: str, threshold: float = 1.0) -> dict:
    """Return {'raw': full markdown, 'fit': query-relevant markdown,
    'matched': bool, 'url': url}.

    Two-pass, per the crawl4ai recommendation: PRUNE boilerplate first, then rank
    what's left against the query with BM25. Pruning first matters — on pages where
    the query terms saturate the chrome (nav, title, links), BM25 alone barely
    filters (it can even return more than raw); pruning removes that chrome so BM25
    ranks real content. Stemming is disabled for non-ASCII queries so the English
    stemmer does not mangle CJK / other non-Latin content.

    If BM25 matches nothing, 'fit' falls back to the de-noised (pruned) page and
    'matched' is False, so the caller can say so instead of silently returning raw.
    """
    # Imported lazily: the stdlib-only paths never load bs4 and lxml.
    from .vendor.crawl4ai.content_filter import BM25ContentFilter, PruningContentFilter

    # Pass 1: de-noise (prune boilerplate to a list of content chunks).
    pruner = PruningContentFilter(
        threshold=config.PRUNE_THRESHOLD, threshold_type="dynamic", min_word_threshold=0)
    # A pruner failure leaves the page as it is.
    try:
        chunks = pruner.filter_content(html) or []
    except Exception:
        chunks = []
    # Pruned HTML, or the original when pruning found nothing.
    pruned_html = "\n".join(chunks) if chunks else html

    # Pass 2: BM25 over the pruned content gives the query-relevant 'fit'.
    flt = BM25ContentFilter(
        user_query=query, bm25_threshold=threshold, use_stemming=_is_ascii(query))
    # Render the pruned page through the BM25 filter.
    bm25_md = markdown._html_to_markdown(pruned_html, url, content_filter=flt)
    # Query-relevant markdown ("" when nothing matched).
    fit = bm25_md["fit"]
    # Whether BM25 kept anything.
    matched = bool(fit)

    # Full-page 'raw' for disk: a raw-only render (no discarded fit pass).
    raw = markdown._html_to_markdown(html, url, content_filter=False)["raw"]
    # Normal for CJK queries: crawl4ai's BM25 tokenizes by whitespace, so Chinese rarely matches.
    if not matched:
        # Nothing is lost: the de-noised page is returned and the full page is saved anyway.
        config._log(f"BM25 matched nothing (common for CJK queries) — "
                    f"keeping de-noised page {len(bm25_md['raw'])}B")
    # Both versions, the match flag and the URL.
    return {
        "raw": raw,
        # Fall back to the de-noised (pruned) page.
        "fit": fit or bm25_md["raw"],
        "matched": matched,
        "url": url,
    }
