"""search_fetch.markdown — deterministic HTML → markdown rendering + char clamp.

Shared by the fetch path, the SERP path and filters.bm25_fit (kept in its own
module so fetch and filters never import each other).
"""

# Knobs (prune threshold).
from . import config

# Shared stderr logger.
from .config import _log

# ── crawl4ai's renderer (vendor/crawl4ai) → markdown ────────────────

def _html_to_markdown(html: str, url: str, content_filter=None) -> dict:
    """Rendered HTML → {'raw': full md, 'fit': filtered md, 'url': url}. When no
    filter is given (None), 'fit' is the de-noised (pruned) page. Pass
    content_filter=False to render RAW ONLY (no fit pass) — used by filters.py to
    get the full-page raw without recomputing a fit it discards."""
    # Imported lazily: the stdlib-only paths never load bs4 and lxml.
    # The default de-noising filter and the renderer (crawl4ai's code, copied into vendor/crawl4ai).
    from .vendor.crawl4ai.content_filter import PruningContentFilter
    from .vendor.crawl4ai.markdown_generator import DefaultMarkdownGenerator
    # No filter given: prune boilerplate for the 'fit' version.
    if content_filter is None:
        content_filter = PruningContentFilter(
            threshold=config.PRUNE_THRESHOLD, threshold_type="dynamic", min_word_threshold=0)
    # False: raw only, no fit pass at all.
    elif content_filter is False:
        content_filter = None
    # Keep links, never re-wrap lines.
    gen = DefaultMarkdownGenerator(options={"ignore_links": False, "body_width": 0})
    # Render once; crawl4ai fills raw and (with a filter) fit.
    res = gen.generate_markdown(input_html=html, base_url=url, content_filter=content_filter)
    # Full page.
    raw = (res.raw_markdown or "").strip()
    # Filtered page ("" for a raw-only render).
    fit = (res.fit_markdown or "").strip()
    # A raw-only render never computes a fit, so its size is not logged ("fit=0B" would read as lost content).
    _log(f"crawl4ai: raw={len(raw)}B" + ("" if content_filter is None else f" fit={len(fit)}B"))
    # Both versions and the page URL.
    return {"raw": raw, "fit": fit, "url": url}


def _clamp_chars(text: str, max_chars: int) -> str:
    """Truncate to ~max_chars on a clean line break, with a marker. The deterministic layer
    only renders and bounds; the caller's writing model does all relevance filtering and summarising,
    and the full page is always saved to disk, so nothing is lost."""
    # None counts as empty.
    text = text or ""
    # No limit, or already short enough.
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    # Hard cut at the limit.
    cut = text[:max_chars]
    # Last line break inside the cut.
    nl = cut.rfind("\n")
    # Prefer a clean line break when it keeps at least 60% of the budget.
    if nl > max_chars * 0.6:
        cut = cut[:nl]
    # Cut text plus a marker that points at the saved copy.
    return cut.rstrip() + f"\n\n…[truncated to ~{max_chars} chars; full page saved to disk]"
