"""search_fetch.config — every environment knob in ONE place.

All timing budgets, size caps, paths and the engine roster live here so the other
modules read a single source of truth. Env prefix: SEARCH_FETCH_*.
"""

import os
import re
import sys
from pathlib import Path

os.environ.setdefault("no_proxy", "127.0.0.1,localhost,::1,.local")

def _default_home() -> Path:
    # Everything mutable (venv, Chrome profile/state, caches) lives INSIDE the
    # package tree — <repo>/home — never scattered under the user's home dir.
    # Deleting the package removes every trace; re-running setup.sh/install.sh
    # reinitialises it. Mirrors sf.py.
    return Path(__file__).resolve().parents[2] / "home"


HOME = Path(os.environ.get("SEARCH_FETCH_HOME") or _default_home())
# Third-party caches follow HOME so nothing lands outside the package:
# yt-dlp's cache (media.py) and tiktoken's BPE download (kb.py — defaults to /tmp/data-gym-cache).
os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(HOME / "tiktoken-cache"))
_RUN_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_TRUE = ("1", "true", "yes", "on")


def run_session(env=None, home: Path = None) -> dict:
    """The run this process belongs to (pure; tests pass `env`/`home`).

    A caller may set SEARCH_FETCH_RUN_ID per writing run; the run directory
    <HOME>/runs/<run id> holds run-scoped state (the known-URL ledger), and the run's id tags
    the tabs the Chrome extension opens so `sf browser stop` closes exactly them.
    No run id (standalone sf use) ⇒ no run directory. An id that is not
    [A-Za-z0-9_-]{1,64} is ignored (it names a directory)."""
    # Inputs.
    env = os.environ if env is None else env
    home = HOME if home is None else home
    # The run id, validated.
    rid = (env.get("SEARCH_FETCH_RUN_ID") or "").strip()
    if rid and not _RUN_ID_RE.fullmatch(rid):
        print(f"[search_fetch] ignoring invalid SEARCH_FETCH_RUN_ID {rid!r}", file=sys.stderr)
        rid = ""
    # Id and directory.
    return {"run_id": rid, "run_dir": home / "runs" / rid if rid else None}


# This process's run.
SESSION = run_session()
# Its run-scoped directory (None standalone).
RUN_DIR = SESSION["run_dir"]

RESULTS_DIRNAME = ".search_fetchres"
# Outbound URL policy (url_guard.py, read at call time so docparse stays stdlib-only):
# http(s) only; non-public addresses refused unless SEARCH_FETCH_ALLOW_PRIVATE=1.
PRUNE_THRESHOLD = float(os.environ.get("SEARCH_FETCH_PRUNE_THRESHOLD", "0.48"))

# Bounded timing budgets (seconds). No unbounded polling anywhere.
READY_TIMEOUT = float(os.environ.get("SEARCH_FETCH_READY_TIMEOUT", "12"))   # page load wait
SETTLE_MAX = float(os.environ.get("SEARCH_FETCH_SETTLE_MAX", "1.6"))        # post-load stabilise cap
FETCH_SETTLE_MAX = float(os.environ.get("SEARCH_FETCH_FETCH_SETTLE", "6.0"))  # CAP for the adaptive content-settle poll (returns as soon as the DOM is stable — fast pages stop early, slow hydrating pages get the full cap)
HUMAN_WAIT = float(os.environ.get("SEARCH_FETCH_HUMAN_WAIT", "80"))         # captcha: allow a human to solve in the open window
HUMAN_POLL = 1.0   # poll often so a solved challenge is detected within ~1s (don't burn the 80s)
# ── Human-like browsing (fixed wait times — defeat bot detection) ────
# Pause before every click/keypress in a search engine, jittered 1–2× this base so the
# rhythm is a person's, not a fixed beat. Tunable, never below 1s.
CLICK_PAUSE = max(1.0, float(os.environ.get("SEARCH_FETCH_CLICK_PAUSE", "1.2")))
# ── Request pacing across ALL sf processes of the machine (pacing.py) ──
# Minimum seconds between two queries to the SAME search engine (+ random 0–50% on top):
# a person does not fire a new search every few seconds, and engines throttle those who do.
SEARCH_GAP = max(10.0, float(os.environ.get("SEARCH_FETCH_SEARCH_GAP", "45")))
# Minimum seconds between two requests to the SAME host (pages, documents, sniffs; + 0–50%).
HOST_GAP = max(2.0, float(os.environ.get("SEARCH_FETCH_HOST_GAP", "8")))
# Minimum seconds between ANY two page navigations of this machine's Chrome (+ 0–100%).
NAV_GAP = max(0.5, float(os.environ.get("SEARCH_FETCH_NAV_GAP", "1.5")))
# Longest a single pacing wait may last: it must stay well under the Rust runner's
# per-call timeouts (search 600s, fetch 240s minus render and document time); a call that
# would wait longer goes ahead after the cap.
PACE_WAIT_MAX = float(os.environ.get("SEARCH_FETCH_PACE_WAIT_MAX", "90"))
# Keep each page (SERP or fetched article) open like a human reading, then close — at most
# 20s when the page is NOT blocked. The complaint was pages closing too fast → looked like a bot.
PAGE_DWELL_MAX = 20.0
PAGE_DWELL = min(PAGE_DWELL_MAX, float(os.environ.get("SEARCH_FETCH_PAGE_DWELL", "2")))
# Fetched ARTICLE pages (different domains, mild bot-detection) use a SHORTER dwell than search
# pages. Still not instant-close; 4s (jittered 2–4.4s) reads more human than the old 2s, and
# parallel fetching (runner default concurrency 4) amortises it to near-zero wall-clock cost.
FETCH_DWELL = min(PAGE_DWELL_MAX, float(os.environ.get("SEARCH_FETCH_FETCH_DWELL", "4")))
AI_CANDIDATE_LIMIT = int(os.environ.get("SEARCH_FETCH_CANDIDATE_LIMIT", "60"))
# Fetch output bound (chars). The deterministic layer RENDERS + BOUNDS only; the caller's
# writing model (JiaWriter) does ALL relevance filtering & summarising. ~24000 chars ≈ 6000 tokens,
# a full long-form article; the FULL page is always saved to disk (_fit/_raw) regardless.
FETCH_MAX_CHARS = int(os.environ.get("SEARCH_FETCH_FETCH_MAX_CHARS", "24000"))
# Documents LINKED on a fetched page (…the report.pdf on its landing page) are downloaded,
# parsed and saved alongside the page markdown — capped per page; 0 disables.
PAGE_DOCS_MAX = int(os.environ.get("SEARCH_FETCH_PAGE_DOCS", "3"))
# Aggregate wall-clock budget for that harvest (sniffs + downloads). It MUST stay well
# under the Rust runner's fetch hard-kill (SEARCH_FETCH_FETCH_TIMEOUT, default 240s) minus
# render time — a page that rendered fine must never turn into a fetch timeout because
# a linked document's server is slow. Downloads in flight when the budget runs out get
# a chance to finish only via their own socket timeouts; remaining links are skipped.
PAGE_DOCS_BUDGET = float(os.environ.get("SEARCH_FETCH_PAGE_DOCS_BUDGET", "45"))
# Browser rendered less markdown than this ⇒ suspect an undisplayable binary (attachment /
# mislabeled document) and give docparse a forced last look at the URL.
DOC_RESCUE_CHARS = 200
# Engines share one Chrome window and the per-engine pacing, so they run SEQUENTIALLY (1)
# by default; raising this opens several result tabs at once.
ENGINE_CONCURRENCY = max(1, int(os.environ.get("SEARCH_FETCH_ENGINE_CONCURRENCY", "1")))
# Allow a human to solve a captcha in the open headed window (the user asked for an 80s manual
# window). Set SEARCH_FETCH_NO_HUMAN=1 for a truly unattended run that should never pause for a human.
ALLOW_HUMAN_WAIT = os.environ.get("SEARCH_FETCH_NO_HUMAN", "0") != "1"
# Human-activity extension: while someone is visibly working the challenge page (mouse
# moves/clicks/keys observed on the top document), each new activity pushes the wait
# deadline out by the GRACE — a slow solver is never cut off mid-interaction. Bounded
# by the *_WAIT_MAX absolute caps (the search/fetch subprocess timeouts of the Rust
# runner sit above these, so an extension can never outlive the process).
HUMAN_ACTIVITY_GRACE = float(os.environ.get("SEARCH_FETCH_HUMAN_ACTIVITY_GRACE", "30"))
HUMAN_WAIT_MAX = float(os.environ.get("SEARCH_FETCH_HUMAN_WAIT_MAX", "300"))
FETCH_HUMAN_WAIT_MAX = float(os.environ.get("SEARCH_FETCH_FETCH_HUMAN_WAIT_MAX", "180"))
# Fetch-path challenge window. Fetches run in PARALLEL (the Rust runner's sliding window),
# so a longer per-page wait costs little wall-clock — and the old 12s window closed pages
# BEFORE a Cloudflare/Turnstile auto-clear (typically 5–30s) could finish, losing content
# that was seconds away. The wait is adaptive (browser._await_content): it returns the
# moment real content appears; only a page that stays a challenge burns the full budget.
# Legacy env SEARCH_FETCH_FETCH_HUMAN_WAIT is honoured when the new name is unset.
FETCH_CHALLENGE_WAIT = float(os.environ.get("SEARCH_FETCH_FETCH_CHALLENGE_WAIT",
                             os.environ.get("SEARCH_FETCH_FETCH_HUMAN_WAIT", "45")))
# A page whose visible text is at least this long (and shows no challenge signals) counts
# as CONTENT — grabbed as soon as its text stabilises, no further waiting.
FETCH_CONTENT_MIN = int(os.environ.get("SEARCH_FETCH_FETCH_CONTENT_MIN", "300"))
# Poll cadence of the fetch wait loop (browser._await_content). Constant in production;
# tests shrink it so the state machine can be exercised in milliseconds.
FETCH_POLL = 1.0
# Per-engine wall-clock budget (seconds): a single engine that hangs returns whatever it has
# collected so far instead of blocking until the Rust hard-kill. Generous because a human-paced
# 3–5 page browse with per-page dwell legitimately takes a while (pages × (dwell + paginate)).
ENGINE_BUDGET = float(os.environ.get("SEARCH_FETCH_ENGINE_BUDGET", "240"))

ENGINES = {
    "google":     lambda lang, region: "https://www.google.com/?hl=" + (lang or "en") + (("&gl=" + region) if region else ""),
    "startpage":  lambda lang, region: "https://www.startpage.com/" + (("?lui=" + lang) if lang else ""),
    "brave":      lambda lang, region: "https://search.brave.com/",
    "bing":       lambda lang, region: "https://www.bing.com/" + (("?setlang=" + lang) if lang else ""),
    "duckduckgo": lambda lang, region: "https://duckduckgo.com/",
    "baidu":      lambda lang, region: "https://www.baidu.com/",
    # Sogou web search already surfaces 微信公众号 articles (mp.weixin.qq.com results, kept via the
    # redirect-aware result extraction) — no separate WeChat engine needed.
    "sogou":      lambda lang, region: "https://www.sogou.com/",
    # Chinese Bing — a "specialized" engine for 宣传调研 (China-region results, incl. mp.weixin).
    "bing_cn":    lambda lang, region: "https://cn.bing.com/?mkt=zh-CN",
}
DEFAULT_ENGINES = ["google", "startpage"]

def _log(msg: str):
    print(f"[search_fetch] {msg}", file=sys.stderr)


# Repo root (…/search_fetch): src/search_fetch/config.py → parents[2]. Anchors the
# source-checkout default home (see _default_home); when the package is INSTALLED
# (venv / PyApp binary) this points inside the environment, which is why the release
# always sets SEARCH_FETCH_HOME explicitly.
REPO_ROOT = Path(__file__).resolve().parents[2]

# ── Media (YouTube subtitles and metadata) ────────────────────────────
# yt-dlp fetches metadata + subtitles for YouTube (and most video sites); media
# without subtitles is represented by its metadata and description (no download,
# no speech recognition).
# Subtitle language preference AFTER the video's original language (comma list).
SUB_LANG_PREF = [s.strip() for s in os.environ.get("SEARCH_FETCH_SUB_LANGS", "zh,en").split(",") if s.strip()]
MEDIA_EXTS = {".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac",
              ".mp4", ".webm", ".mov", ".mkv", ".avi"}

