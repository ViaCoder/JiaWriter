"""The parts of crawl4ai 0.9.0 search_fetch uses, copied so that the package (with Playwright, Patchright,
litellm, scipy and the rest of crawl4ai's dependencies) is not needed.

  markdown_generator  DefaultMarkdownGenerator and MarkdownGenerationResult (a dataclass here)
  content_filter      PruningContentFilter, BM25ContentFilter, clean_tokens; BM25Okapi in plain Python
  html2text/          crawl4ai's copy of html2text with CustomHTML2Text (its command line left out)

Licenses: crawl4ai is Apache-2.0 (LICENSE), rank_bm25 is Apache-2.0 (LICENSE.rank_bm25), and html2text is
GPL-3.0 (html2text/COPYING). Copied from the crawl4ai 0.9.0 and rank_bm25 0.2.2 wheels on PyPI (2026-11-02).
"""
