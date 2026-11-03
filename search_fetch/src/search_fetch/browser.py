"""search_fetch.browser — pages in the user's own Chrome (through the extension bridge) and
the page-driving helpers.

Every page is opened by the search_fetch extension in a dedicated window of the user's
real Chrome (see bridge.py): sites see a genuine browser with its own profile, history,
GPU and version; nothing is spoofed and no automation protocol is attached. Page work is
done by the fixed scripts in extension/ops/ (`ExtPage.run`). Page states come from the
deterministic checks below; no model is involved (see the Model hook section).
"""

# Async page work.
import asyncio

# JSON results of the page scripts.
import json

# Jittered dwell.
import random

# Removing the run directory.
import shutil

# stderr banner for human waits.
import sys

# Deadlines.
import time

# The extension bridge, knobs and request pacing.
from . import bridge, config, pacing

# Shared stderr logger.
from .config import _log

# ── Pages in the user's Chrome (extension bridge) ───────────────────

def _load_ms() -> int:
    """How long the extension waits for a page load (ms)."""
    # The ready budget of the old CDP path.
    return int(config.READY_TIMEOUT * 1000)


def _request_timeout() -> float:
    """Timeout of one load request (s): the load wait plus a margin for the round trip."""
    # Load wait plus 15 s.
    return config.READY_TIMEOUT + 15


class ExtPage:
    """One tab opened by the extension; the subset of a page API search/fetch use."""

    def __init__(self, info: dict):
        # Tab id in the user's Chrome.
        self.tab = info["tab"]
        # URL, title and load flag.
        self._set(info)

    def _set(self, info: dict) -> None:
        """Remember what the extension reported about the tab."""
        # Final address.
        self.url = info.get("url", "")
        # Document title.
        self.title = info.get("title", "")
        # Whether the load wait ran out.
        self.timed_out = bool(info.get("timedOut"))

    async def get(self, url: str) -> None:
        """Load url in this tab (a page turn) and wait for it."""
        # Navigation by the extension; the reply describes the loaded tab.
        self._set(await bridge.acall("navigate", timeout=_request_timeout(), tab=self.tab, url=url, load_ms=_load_ms()))

    async def back(self) -> None:
        """One step back in the tab's history."""
        # History navigation by the extension.
        self._set(await bridge.acall("back", timeout=_request_timeout(), tab=self.tab, load_ms=_load_ms()))

    async def run(self, script: str, args: dict = None, world: str = "ISOLATED"):
        """Run one fixed page script from extension/ops/ and return its value."""
        # The extension refuses unknown script names.
        return await bridge.acall("run", timeout=30, tab=self.tab, script=script, args=args or {}, world=world)

    async def input(self, op: str, **args) -> dict:
        """One trusted-input action of the extension (human_click, human_type, human_scroll) on this tab."""
        # Input may navigate: the load wait plus a margin.
        return await bridge.acall(op, timeout=_request_timeout() + 30, tab=self.tab, load_ms=_load_ms(), **args)

    async def get_content(self) -> str:
        """The rendered HTML."""
        # outerHTML of the document.
        return await self.run("html") or ""

    async def wait(self, seconds: float) -> None:
        """Pause (the page keeps running in Chrome)."""
        # Plain sleep.
        await asyncio.sleep(seconds)

    async def activate(self) -> None:
        """Bring the tab to the front so a person can work on it."""
        # Focus its window and tab.
        await bridge.acall("activate", timeout=10, tab=self.tab)

    async def close(self) -> None:
        """Close the tab."""
        # Closed by the extension.
        await bridge.acall("close", timeout=10, tab=self.tab)


class ExtBrowser:
    """The user's Chrome as seen through the bridge."""

    async def get(self, url: str, new_tab: bool = True) -> ExtPage:
        """Open url in a new tab of the dedicated window and wait for it to load."""
        # Tagged with the run id so `sf browser stop` can close this run's tabs.
        info = await bridge.acall("open", timeout=_request_timeout(), url=url,
                                  run=config.SESSION["run_id"], load_ms=_load_ms())
        # The tab.
        return ExtPage(info)


async def _connect() -> ExtBrowser:
    """The bridge to the user's Chrome; BridgeUnavailable (with setup steps) when it is not connected."""
    # Ask the extension who it is.
    st = await bridge.acall("status", timeout=10)
    # One log line.
    _log(f"bridge: Chrome extension {st.get('version')} connected")
    # The browser handle.
    return ExtBrowser()


def stop_browser() -> dict:
    """`sf browser stop`: close every tab this run opened and delete the run directory
    (its known-URL ledger). Returns {closed, connected, run_dir_removed}."""
    # Close by run id (all bridge tabs when standalone).
    try:
        rep = {"closed": int(bridge.call("close_run", timeout=20, run=config.SESSION["run_id"]) or 0), "connected": True}
    except (bridge.BridgeUnavailable, bridge.BridgeError, OSError) as ex:
        # Nothing to close without Chrome; not an error for the caller.
        rep = {"closed": 0, "connected": False, "error": str(ex)}
    # Run-scoped state ends with the run.
    run_dir = config.RUN_DIR
    rep["run_dir_removed"] = bool(run_dir and run_dir.is_dir())
    if rep["run_dir_removed"]:
        shutil.rmtree(run_dir, ignore_errors=True)
    # The report.
    return rep


async def _open(browser, url, engine: str = ""):
    """Open url in a new tab after its pacing turn; engine names a new query to that search engine."""
    # Wait until this host (and engine) may be visited again.
    await pacing.before_navigation(url, engine)
    # Log the navigation.
    _log(f"→ {url}")
    # New tab.
    return await browser.get(url, new_tab=True)


async def _close_page(page):
    """Best-effort close a tab so open pages don't pile up."""
    # Nothing to close.
    if page is None:
        return
    # A tab the user already closed is fine.
    try:
        await page.close()
    except Exception:
        pass


async def _ready(page):
    """Brief fixed settle after a load (the extension already waited for the load event).
    Does NO scrolling: scrolling is only the driver's explicit `scroll` action."""
    # Short settle for late scripts.
    await asyncio.sleep(min(config.SETTLE_MAX, 0.6))


async def _pace():
    """Pause before a click/keypress in a search engine: 1–2× CLICK_PAUSE (≥1s), jittered so the
    driver never acts faster than a person nor on a fixed beat (both are bot-detection signals)."""
    # Jittered human pause.
    await asyncio.sleep(pacing.jittered(config.CLICK_PAUSE, 1.0))


async def _dwell(page, seconds: float = None):
    """Keep a page open like a human reading it, then return so the caller can close — at
    most config.PAGE_DWELL_MAX. The duration is JITTERED (0.5–1.1× the base)."""
    # Base dwell.
    base = min(config.PAGE_DWELL_MAX, seconds if seconds is not None else config.PAGE_DWELL)
    # Jittered sleep.
    await asyncio.sleep(min(config.PAGE_DWELL_MAX, random.uniform(0.5 * base, 1.1 * base)))


async def _probe(page) -> dict:
    """Cheap fetch-loop snapshot (ops/probe.js, MAIN world: it reads window._cf_chl_opt)."""
    # Run the probe; any failure gives an empty snapshot.
    try:
        raw = await page.run("probe", world="MAIN")
        obs = raw if isinstance(raw, dict) else json.loads(raw)
        if isinstance(obs, dict):
            return obs
    except Exception:
        pass
    # Empty snapshot with every field _looks_challenged reads.
    return {"title": "", "textLen": 0, "excerpt": "", "challengeIframe": False, "cfChallenge": False, "cfCleared": False}


def _fetch_verdict(obs: dict) -> str:
    """Deterministic per-poll classification of a fetched page:
      'challenge' — an anti-bot wall (challenge iframe / short challenge text) REPLACES the page;
      'content'   — substantial visible text and no challenge signals: fetchable now;
      'blank'     — neither: still loading, empty render, or an undisplayable binary.
    _looks_challenged already treats cfCleared and a ≥500-char excerpt as NOT challenged
    (a consent banner / embedded captcha widget over real content is not a wall)."""
    if _looks_challenged(obs):
        # A page that ALREADY meets the content bar and shows no interstitial text was
        # flagged only by an embedded widget iframe (a comment-form recaptcha, not a wall
        # — a true wall REPLACES the page with short challenge text). Fetch it as content
        # instead of burning the whole challenge budget and dropping a real page.
        text = (obs.get("title", "") + " " + obs.get("excerpt", "")).lower()
        if len(obs.get("excerpt", "")) >= config.FETCH_CONTENT_MIN \
                and not any(m in text for m in _CHALLENGE_MARKS):
            return "content"
        return "challenge"
    if len(obs.get("excerpt", "")) >= config.FETCH_CONTENT_MIN:
        return "content"
    return "blank"


async def _await_content(page, url: str = ""):
    """The fetch path's unified adaptive wait — each page state gets its OWN budget, so a
    bot-check page is never closed before it can clear, and a ready content page is never
    kept waiting. Polls _probe every second and:
      • content   → return as soon as the text size is stable across two polls (dynamic
                    content finished), capped at FETCH_SETTLE_MAX from first sighting;
      • challenge → keep waiting up to FETCH_CHALLENGE_WAIT from first sighting (Cloudflare/
                    Turnstile auto-clears take 5–30s; a human may also solve it in the headed
                    window). The moment it clears, the page usually reloads — stability and
                    blank budgets restart so the REAL content gets read, not the transition;
      • blank     → up to FETCH_SETTLE_MAX from first sighting (restarted after a challenge),
                    then give up and let the caller decide (doc rescue handles binaries).
    Returns (verdict, last_probe) where verdict is the FINAL state: 'content' | 'challenge'
    | 'blank'. Never exceeds a hard cap well under the Rust runner's fetch hard-kill."""
    poll = config.FETCH_POLL
    start = time.monotonic()
    # The hard cap leaves room for the human-activity extension (bounded by
    # FETCH_HUMAN_WAIT_MAX) when a human may be solving in the headed window.
    max_chal = (max(config.FETCH_CHALLENGE_WAIT, config.FETCH_HUMAN_WAIT_MAX)
                if config.ALLOW_HUMAN_WAIT else config.FETCH_CHALLENGE_WAIT)
    hard_cap = max_chal + 2 * config.FETCH_SETTLE_MAX + 10
    challenge_since = content_since = blank_since = None
    chal_deadline = None
    seen_activity = 0.0
    announced = False
    last_len = -1
    obs = await _probe(page)
    while True:
        now = time.monotonic()
        verdict = _fetch_verdict(obs)
        if verdict == "content":
            if obs.get("textLen", 0) == last_len:
                return "content", obs          # stable across two polls — done
            content_since = content_since or now
            if now - content_since >= config.FETCH_SETTLE_MAX:
                return "content", obs          # never chase an ever-mutating page (rotating ads)
            last_len = obs.get("textLen", 0)
            blank_since = challenge_since = None
        elif verdict == "challenge":
            if challenge_since is None:
                challenge_since = now
                chal_deadline = now + config.FETCH_CHALLENGE_WAIT
                seen_activity = 0.0
            if not announced:
                announced = True
                hint = ", or solve it in the Chrome window" if config.ALLOW_HUMAN_WAIT else ""
                _log(f"bot-check on {url or '(page)'} — waiting up to "
                     f"{config.FETCH_CHALLENGE_WAIT:.0f}s for it to clear (auto-clear{hint})")
            if config.ALLOW_HUMAN_WAIT:
                # A human working the page: each NEW activity pushes the deadline out (bounded by max_chal).
                await _install_activity_probe(page)
                act = await _last_activity(page)
                if act > seen_activity:
                    seen_activity = act
                    extended = min(now + config.HUMAN_ACTIVITY_GRACE, challenge_since + max_chal)
                    if extended > chal_deadline:
                        chal_deadline = extended
                        _log(f"human activity — challenge wait extended ({int(chal_deadline - now)}s left)")
            if now >= chal_deadline:
                return "challenge", obs
            # A clear typically reloads the page — restart the other budgets.
            content_since = blank_since = None
            last_len = -1
        else:  # blank
            blank_since = blank_since or now
            if now - blank_since >= config.FETCH_SETTLE_MAX:
                return "blank", obs
            # A fresh blank (post-challenge reload, mid-hydration wipe) restarts BOTH the
            # content settle window and the challenge budget — a SECOND challenge stage
            # after a reload gets its own full wait (the hard cap still bounds the total).
            content_since = challenge_since = None
            last_len = -1
        if now - start >= hard_cap:
            return verdict, obs
        await asyncio.sleep(poll)
        obs = await _probe(page)

# ── Model hook (no model in JiaWriter's sf, 2026-11-01) ───────────
# sf runs without any model, at the user's request: page states come from the heuristics in
# this file, pagination from deterministic signals in search.py. To add a model later, bring
# back a driver-model call (WriterSuite's search_fetch at commit 5f8a67e has one: SF_URL /
# SF_KEY / SF_MODEL / SF_API over the official openai / anthropic SDKs, tested by
# tests/test_llm_sdk.py) and call it at the two points marked "model hook":
# search._next_page (step 4) and fetch._still_blocked.

# ── Page observation (compact accessibility snapshot) ───────────────

async def _observe(page) -> dict:
    """Visible controls (tagged data-wf-id) plus page facts (ops/observe.js)."""
    # Full observation.
    try:
        raw = await page.run("observe", {"limit": config.AI_CANDIDATE_LIMIT})
        obs = raw if isinstance(raw, dict) else json.loads(raw)
        if isinstance(obs, dict):
            return obs
    except Exception:
        pass
    # A degraded snapshot keeps the drive loop alive on a transient failure.
    try:
        url = await page.run("url")
    except Exception:
        url = ""
    # Minimal fields.
    return {"url": url, "title": "", "excerpt": "", "challengeIframe": False, "elements": []}


def _looks_challenged(obs: dict) -> bool:
    """Minimal deterministic challenge signal — only gates the fetch fast-path's
    page check and the search human-wait poll."""
    if obs.get("cfCleared"):  # definitive solved-token signal short-circuits to "cleared"
        return False
    # A Cloudflare challenge that has NOT been solved is a wall regardless of how it is
    # branded or worded — the phrase list and the iframe selector both miss the managed and
    # customised variants, and missing it costs the page: it falls through to 'blank', gets
    # the short budget and is closed within seconds, leaving no time for the check to clear
    # or for a human to click. The signal is only trusted while real content is absent, so
    # a challenge-platform script left on a page that has already rendered does not wall it.
    if obs.get("cfChallenge") and len(obs.get("excerpt", "")) < 500:
        return True
    # If substantial real content is ALREADY in the DOM, the page is FETCHABLE even when a cookie/
    # privacy/consent banner or an embedded captcha widget overlays it — that is not a bot wall and
    # needs no human wait (a true Cloudflare/anti-bot interstitial REPLACES the page, leaving only
    # short challenge text). Just fetch the main text.
    if len(obs.get("excerpt", "")) >= 500:
        return False
    if obs.get("challengeIframe"):
        return True
    text = (obs.get("title", "") + " " + obs.get("excerpt", "")).lower()
    return len(obs.get("excerpt", "")) < 220 and any(m in text for m in _CHALLENGE_MARKS)


# Interstitial text every major anti-bot wall shows — shared by _looks_challenged and
# _fetch_verdict (which uses their ABSENCE to tell an embedded captcha widget on a real
# page from a genuine wall).
_CHALLENGE_MARKS = ("just a moment", "verify you are human", "are you a robot",
                    "checking your browser", "unusual traffic", "access denied")


# ── Acting on an observed element ───────────────────────────────────

async def _act(page, decision: dict) -> None:
    """Carry out an action on the element observe.js tagged with target_id, with the trusted
    mouse and keyboard input of the extension (as a person would: move, click, type, Enter)."""
    # Action and target.
    action = decision.get("action")
    target = {"wfId": decision.get("target_id")}
    # Click into the field, type the text and press Enter.
    if action == "type":
        await page.input("human_type", target=target, text=decision.get("text", ""), enter=True)
    # Click into the field and press Enter.
    elif action == "press_enter":
        await page.input("human_type", target=target, text="", enter=True)
    # Wheel to the element, move the pointer there and click (nothing happens when it is gone).
    elif action == "click":
        await page.input("human_click", target=target)
    # A few wheel turns down.
    elif action == "scroll":
        await page.input("human_scroll", steps=4)


async def _install_activity_probe(page):
    """Stamp window.__wfLast on mouse/key/touch events (idempotent per page)."""
    # Best effort.
    try:
        await page.run("activity_install")
    except Exception:
        pass


async def _last_activity(page) -> float:
    """Latest activity stamp (ms epoch) on the page, 0 when none/unavailable."""
    # Best effort.
    try:
        return float(await page.run("activity_last") or 0)
    except Exception:
        return 0.0


async def _human_wait(page, ctx: dict, budget: float = 0.0) -> bool:
    """Bounded wait for a human to clear a challenge in the open Chrome window — the SEARCH
    path's challenge handling (the fetch path uses _await_content instead). Polls a
    deterministic signal (no LLM spam); never the old 600s. `budget` overrides the window
    (0 = the full config.HUMAN_WAIT)."""
    budget = budget or config.HUMAN_WAIT
    # Bring the challenge tab to the front of the user's Chrome.
    try:
        await page.activate()
    except Exception:
        pass
    sys.stderr.write(
        "\n" + "═" * 64 + f"\n⚠  Human verification needed: {ctx.get('url','')}\n"
        f"   Solve it in the Chrome window; I'll wait up to {int(budget)}s.\n" + "═" * 64 + "\n")
    sys.stderr.flush()
    deadline = time.time() + budget
    cap = time.time() + max(budget, config.HUMAN_WAIT_MAX)
    seen_activity = 0.0
    while time.time() < deadline:
        await _install_activity_probe(page)  # reload-safe: idempotent, reinstalls after navigations
        await page.wait(config.HUMAN_POLL)
        try:
            if not _looks_challenged(await _observe(page)):
                _log("✓ challenge cleared")
                return True
        except Exception:
            pass
        # A human visibly working the page gets more time — every NEW mouse/key event
        # pushes the deadline out by HUMAN_ACTIVITY_GRACE (bounded by HUMAN_WAIT_MAX),
        # so slow solvers aren't cut off mid-interaction.
        act = await _last_activity(page)
        if act > seen_activity:
            seen_activity = act
            extended = min(time.time() + config.HUMAN_ACTIVITY_GRACE, cap)
            if extended > deadline:
                deadline = extended
                _log(f"human activity on the page — extending wait ({int(deadline - time.time())}s left)")
    _log("✗ challenge not cleared within budget")
    return False
