"""search_fetch — WriterAgent's web Search + Fetch backend (WA_SEARCH=sf) through the user's own Chrome (extension bridge),
with document parsing (text layers only, no OCR), media metadata and YouTube
subtitles (no speech recognition), and a hybrid-retrieval knowledge base.
Invoked as a subprocess (WriterAgent's WA_SF); it uses no driver model (LLM) and
needs no key; it is not an MCP server.

Modules:
    config     every env knob (SEARCH_FETCH_*) in one place
    bridge     the Chrome extension bridge (native messaging host + local socket client)
    browser    pages in the user's Chrome + deterministic page-state checks
    search     multi-engine SERP path
    fetch      URL → markdown ladder (media → document → browser)
    markdown   deterministic HTML→markdown + clamps
    artifacts  everything written to ./.search_fetchres/
    filters    BM25 relevance filtering + token clamp (LLM-free)
    docparse   pdf/docx/pptx/xlsx/csv → text (text layer only)
    media      media metadata + YouTube subtitles
    kb         chunk → embed (bge-m3) → hybrid retrieve sidecar
    cli        the single script-invocation surface (sf.py)
"""

__version__ = "2.0.0"
