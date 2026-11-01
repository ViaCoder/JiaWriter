#!/usr/bin/env python3
"""sf.py — the search_fetch dev/source-checkout shim (what SEARCH_FETCH_ENGINE
points at when running from this repo; the release ships a PyApp binary that
runs the same `search_fetch.__main__` entry instead).

Inserts ./src on sys.path, then hands off to search_fetch.__main__ — which owns
the rag.env seeding (real env wins) and the CLI dispatch. Stdlib-only until then.
"""
import os
import sys

# Dev-run bytecode caches go to the suite-level unified temp root (.tmp/pycache)
# instead of littering src/ with __pycache__/ — must be set BEFORE the package
# imports below compile anything. Harmless if .tmp is wiped: caches regenerate.
sys.pycache_prefix = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tmp", "pycache"
)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from search_fetch.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
