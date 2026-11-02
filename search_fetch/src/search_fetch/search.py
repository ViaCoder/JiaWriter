"""search_fetch.search — the multi-engine SERP path.

URL-template navigation first (immune to DOM redesigns); pagination falls back
to the layered _next_page (deterministic next-controls; no model, see its Model hook).
The rendered results page is returned as crawl4ai markdown as-is — no custom
result parsing; DOM result links are appended for the machine consumer.
"""

import asyncio
import json
import re
import urllib.parse

from . import artifacts, browser, config, markdown, pacing
from .config import _log


def _fresh_param(eng, fresh):
    """Engine-native time-range URL fragment for fresh in {day,week,month,year}.
    Unknown engine/window -> "" (no filter; timeliness then relies on reader-side
    screening). Params are appended to the results URL, so a wrong guess degrades
    to the engine ignoring it rather than breaking the page."""
    if not fresh:
        return ""
    f = str(fresh).lower()
    if eng == "google":
        m = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(f)
        return f"&tbs=qdr:{m}" if m else ""
    if eng in ("bing", "bing_cn"):
        m = {"day": "ez1", "week": "ez2", "month": "ez3"}.get(f)
        return f'&filters=ex1%3a%22{m}%22' if m else ""
    if eng == "duckduckgo":
        m = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(f)
        return f"&df={m}" if m else ""
    if eng == "brave":
        m = {"day": "pd", "week": "pw", "month": "pm", "year": "py"}.get(f)
        return f"&tf={m}" if m else ""
    if eng == "sogou":
        m = {"day": "1", "week": "2", "month": "3"}.get(f)
        return f"&tsn={m}" if m else ""
    if eng == "baidu":
        import time as _t
        days = {"day": 1, "week": 7, "month": 31, "year": 366}.get(f)
        if not days:
            return ""
        end = int(_t.time())
        start = end - days * 86400
        return f"&gpc=stf%3D{start}%2C{end}%7Cstftype%3D1"
    if eng == "startpage":
        m = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(f)
        return f"&with_date={m}" if m else ""
    return ""


def _page_url(eng, query, page, lang=None, region=None, fresh=None):
    """Deterministic results-URL for PAGE `page` (1-based). EVERY engine is driven by navigating
    these URLs directly — zero typing, zero clicking, zero AI in the search path (the cause of the
    earlier erratic behavior). Patterns verified against SearXNG's engine modules. Returns None to
    mean "no further page" (DuckDuckGo html + Startpage have no clean GET pagination → page-1 only,
    but page 1 already returns ~20-30 results)."""
    q = urllib.parse.quote_plus(query)
    off10 = 10 * (page - 1)
    if eng == "bing":
        return f"https://www.bing.com/search?q={q}&first={1 + off10}" + _fresh_param(eng, fresh)
    if eng == "bing_cn":
        return f"https://cn.bing.com/search?q={q}&first={1 + off10}&mkt=zh-CN" + _fresh_param(eng, fresh)
    if eng == "google":
        return f"https://www.google.com/search?q={q}&start={off10}" + (f"&hl={lang}" if lang else "") + _fresh_param(eng, fresh)
    if eng == "baidu":
        return f"https://www.baidu.com/s?wd={q}&rn=10&pn={off10}" + _fresh_param(eng, fresh)
    if eng == "sogou":
        return f"https://www.sogou.com/web?query={q}&page={page}" + _fresh_param(eng, fresh)
    if eng == "brave":
        return f"https://search.brave.com/search?q={q}" + (f"&offset={page - 1}" if page > 1 else "") + _fresh_param(eng, fresh)
    if eng == "duckduckgo":
        return (f"https://html.duckduckgo.com/html/?q={q}" + _fresh_param(eng, fresh)) if page == 1 else None
    if eng == "startpage":
        return (f"https://www.startpage.com/sp/search?query={q}&t=device" + _fresh_param(eng, fresh)) if page == 1 else None
    # Roster/template coherence: an engine that exists in config.ENGINES but has no template here
    # (a newly added or injected engine) still gets a working page 1 — its base URL from the
    # roster; deeper pages have no template → the layered _next_page fallback drives them.
    if page == 1 and eng in config.ENGINES:
        try:
            return config.ENGINES[eng](lang, region)
        except Exception:
            return None
    return None

# ── Search path (engines run concurrently) ──────────────────────────

# Extract the actual result-title links from the SERP DOM. Result titles live in
# heading tags (h2/h3) wrapped in or wrapping an <a> across all engines (Bing
# li.b_algo h2 a, Google a>h3, Baidu/Sogou h3 a). crawl4ai's pruned markdown drops
# these on some SERPs, so we pull them straight from the DOM — this is result-list
# METADATA (links), not content filtering; the linked pages are still fetched+read.
# SERP result links come from extension/ops/results.js ({u: href, t: title} per link).



async def _serp_results(page) -> list:
    try:
        return json.loads(await page.run("results")) or []
    except Exception:
        return []


async def _serp_markdown(page) -> str:
    html = await page.get_content()
    try:
        url = await page.run("url")
    except Exception:
        url = ""
    md = markdown._html_to_markdown(html, url)
    body = md.get("fit") or md.get("raw") or ""
    # Append the real result links pulled from the DOM, so the saved SERP shows the
    # actual (page-specific) results and the reader/URL-extractor get clean links even
    # when crawl4ai's markdown stripped them.
    results = await _serp_results(page)
    if results:
        lines = ["", "## 检索结果链接"]
        for r in results:
            lines.append(f"- [{r.get('t', '')}]({r.get('u', '')})")
        body = (body + "\n" + "\n".join(lines)).strip()
    return body


async def _content_extent(page) -> int:
    """Cheap fingerprint of 'how much results content is on the page' — scroll
    height + link count. Grows when an infinite-scroll engine (e.g. Sogou) appends
    the next batch of results without changing the URL, so it lets pagination detect
    advancement even when location.href is unchanged."""
    try:
        return int(await page.run("extent"))
    except Exception:
        return 0


async def _cur_url(page) -> str:
    try:
        return await page.run("url")
    except Exception:
        return ""


# A page we should NOT be on mid-search — a misclick landed us on settings/login/help instead
# of the results. Used to recover (go back) so one bad click can't derail the whole engine.
_OFFTRACK_RE = re.compile(
    r"/(settings|preferences|prefs|account|profile|login|signin|sign-in|register|signup|"
    r"help|support|about|legal|privacy|terms|feedback)\b|设置|偏好设置|登录|注册|帮助中心",
    re.I)


def _is_offtrack(url, title="") -> bool:
    return bool(_OFFTRACK_RE.search((url or "") + " " + (title or "")))


async def _go_back(page):
    """Return to the previous page after a misclick (settings/etc.), then settle."""
    try:
        await page.back()
        await browser._ready(page)
        await page.wait(0.6)
    except Exception:
        pass


async def _on_results(page, base_url) -> bool:
    """True if we're on a genuine results page (has result anchors) and NOT off-track. If a
    click landed us on settings/login/etc., go BACK to base_url and report False."""
    url = await _cur_url(page)
    if _is_offtrack(url):
        await _go_back(page)
        return False
    return bool(await _serp_results(page))


async def _next_page(page, pno: int, ops=None, eng="") -> bool:
    """Advance EXACTLY one results page. Layered + robust to frontend changes:
    deterministic numbered/next-link/more-button/infinite-scroll in turn (a model pick of the
    next control is a later hook, see below). Confirms a real effect (URL changed or the
    results grew) at every step so it never reports false progress."""
    base_url = await _cur_url(page)
    base_ext = await _content_extent(page)

    # 1. Bring the bottom pagination / lazy results into view, then look for the control.
    #    Skip anything flagged `avoid` (settings/login/help) so a clearly-wrong link is never clicked.
    await page.input("human_scroll", steps=5, px=800)
    await page.wait(1.0)
    obs = await browser._observe(page)
    els = [e for e in obs.get("elements", []) if not e.get("avoid")]
    target = next((e for e in els if e.get("nextish")), None) \
        or next((e for e in els if e.get("pagenum") == pno + 1), None)

    if target:
        await browser._pace()    # ≥1s before clicking the next-page control (human cadence)
        await browser._act(page, {"action": "click", "target_id": target["id"]})
        await browser._ready(page)
        await page.wait(0.6)
        new_url = await _cur_url(page)
        # Confirm we actually reached results (not settings/etc. via a misclick → _on_results
        # goes back). Only then is it a real advance.
        if new_url and new_url != base_url and await _on_results(page, base_url):
            if ops:
                artifacts._trace(ops, {"stage": "next_page", "result_page": pno, "via": "click",
                             "target": target.get("text", "")[:20], "advanced": True})
            return True

    # 1b. Explicit "Next" link/button (rel=next, aria-label, or text Next/下一页/»/›/→), tagged by
    #     ops/next_link.js and clicked with trusted input — many
    #     engines (Startpage, some Bing/Google variants) use this instead of a numbered control.
    #     EXCLUDE settings/login/help links so ">"-style glyphs on nav can't hijack the click.
    try:
        nx = await page.run("next_link")
    except Exception:
        nx = False
    if nx:
        await browser._pace()
        await browser._act(page, {"action": "click", "target_id": "wfnext"})
        await browser._ready(page)
        await page.wait(0.6)
        grew = await _content_extent(page) > base_ext * 1.1
        moved = (await _cur_url(page)) != base_url
        if (moved and await _on_results(page, base_url)) or (not moved and grew):
            if ops:
                artifacts._trace(ops, {"stage": "next_page", "result_page": pno, "via": "next_link", "advanced": True})
            return True

    # 2. "More results" / 加载更多 button — DuckDuckGo and other engines load the next batch on
    #    an explicit button rather than on raw scroll. Click it and confirm the results grew.
    try:
        clicked = await page.run("more_button")
    except Exception:
        clicked = False
    if clicked:
        await browser._pace()
        await browser._act(page, {"action": "click", "target_id": "wfmore"})
        await page.wait(1.4)
        if await _content_extent(page) > base_ext * 1.1 and not _is_offtrack(await _cur_url(page)):
            if ops:
                artifacts._trace(ops, {"stage": "next_page", "result_page": pno, "via": "more_btn", "advanced": True})
            return True
        if _is_offtrack(await _cur_url(page)):
            await _go_back(page)

    # 3. Pure infinite scroll: scroll several times; advancement = the results grew (lower
    #    threshold + more tries than before, so a slow lazy-load isn't missed → e.g. Sogou).
    for _ in range(4):
        await page.input("human_scroll", steps=5, px=800)
        await page.wait(1.2)
        if await _content_extent(page) > base_ext * 1.1:
            if ops:
                artifacts._trace(ops, {"stage": "next_page", "result_page": pno, "via": "scroll",
                             "advanced": True})
            return True

    # 4. Model hook: a model pick of the next/more control would go here (see browser.py
    #    "Model hook"); without it the deterministic signals above decide.

    # Final check: URL may have changed late (slow nav).
    advanced = (await _cur_url(page)) != base_url
    if ops:
        artifacts._trace(ops, {"stage": "next_page", "result_page": pno, "via": "none",
                     "advanced": advanced})
    return advanced


# Preferred ACCEPT wording on a consent wall (accept/agree/alle akzeptieren/aceptar/同意/接受…).
# The observe layer flags `consentish` candidates, but since the old driver loop was deleted
# nothing ever ACTED on them — a consent-gated engine parsed 0 results on page 1 and stopped.
_CONSENT_ACCEPT_RE = re.compile(
    r"accept|agree|allow|akzeptieren|aceptar|accepter|同意|接受|允许|确定", re.I)


async def _accept_consent(page, obs) -> bool:
    """Deterministically dismiss a consent wall (no LLM): among the observation's consentish
    candidates, click the one whose text matches an accept/agree control (first candidate if
    none matches), then settle briefly so the caller can re-parse. True iff a click happened."""
    cands = [e for e in obs.get("elements", []) if e.get("consentish") and not e.get("avoid")]
    if not cands:
        return False
    target = next((e for e in cands if _CONSENT_ACCEPT_RE.search(e.get("text", ""))), cands[0])
    await browser._pace()    # ≥1s before the click (human cadence)
    try:
        await browser._act(page, {"action": "click", "target_id": target["id"]})
    except Exception:
        return False
    await browser._ready(page)
    await page.wait(0.8)
    return True


async def _run_engine(br, eng, query, pages, lang, region, ops, fresh=None) -> list:
    """URL-TEMPLATE FIRST: each results page is reached by navigating the engine's results URL
    (immune to DOM redesigns). Engines without a GET template past page 1 (ddg/startpage) fall
    back to the LAYERED _next_page (deterministic next-controls); an empty
    TEMPLATED page ≥2 gets that same rescue ONCE (from the previous results page) before the
    engine gives up, so a frontend change degrades gracefully instead of ending pagination.
    A blocked page gets the human-solve window; a consent wall on page 1 is dismissed
    deterministically (click accept, re-parse once); an empty page 1 stops this engine (run
    `engine.py selftest` to tell markup drift from a block)."""
    blocks = []
    page = None
    prev_url = None      # last GOOD results-page URL — start point for the templated rescue
    fell_back = False    # the empty-templated-page _next_page rescue is one-shot per engine
    try:
        for pno in range(1, pages + 1):
            url = _page_url(eng, query, pno, lang, region, fresh)
            if page is None:
                # Page 1 always has a URL template; a new query waits for this engine's pacing turn.
                page = await browser._open(br, url, engine=eng)
            elif url is not None:
                await browser._pace()                       # human cadence between page turns
                await pacing.before_navigation(url)         # host pacing for the page turn
                await page.get(url)                 # URL-template nav (immune to DOM redesigns)
            else:
                # No GET template for this page (ddg/startpage load results in place):
                # LAYERED click/scroll pagination with deterministic next-controls
                # (link, button, scroll), which survives most frontend changes.
                await browser._pace()
                # Click pagination stays on the engine's host: pace it like a URL page turn.
                await pacing.before_navigation(prev_url or config.ENGINES[eng](lang, region))
                if not await _next_page(page, pno - 1, ops, eng):
                    artifacts._trace(ops, {"engine": eng, "stage": "no_next_page", "result_page": pno})
                    break
            await browser._ready(page)
            # Poll for JS-rendered results (Sogou/Baidu populate after ready) before judging empty.
            results = []
            for _ in range(6):
                results = await _serp_results(page)
                if results:
                    break
                await page.wait(0.7)
            if not results:
                obs = await browser._observe(page)
                # Deterministic bot-challenge check → optional HUMAN solve in the headed window, else stop.
                if browser._looks_challenged(obs):
                    if config.ALLOW_HUMAN_WAIT and await browser._human_wait(page, {"engine": eng, "url": url}):
                        results = await _serp_results(page)
                    else:
                        artifacts._trace(ops, {"engine": eng, "stage": "challenged", "result_page": pno})
                        break
                # Consent wall on page 1: click the accept control deterministically (no LLM —
                # nothing acted on the consentish flag since the old driver loop was deleted),
                # settle, and re-parse once.
                elif pno == 1 and await _accept_consent(page, obs):
                    artifacts._trace(ops, {"engine": eng, "stage": "consent_clicked", "result_page": pno})
                    results = await _serp_results(page)
            if not results and pno > 1 and url is not None and not fell_back:
                # Empty TEMPLATED page ≥2 (offset pattern drifted or a soft block): ONE rescue
                # via the layered _next_page that ddg/startpage already use — return the SAME
                # tab to the previous results page, then advance by DOM/click/scroll.
                fell_back = True
                if prev_url:
                    await page.get(prev_url)
                    await browser._ready(page)
                if await _next_page(page, pno - 1, ops, eng):
                    for _ in range(6):
                        results = await _serp_results(page)
                        if results:
                            break
                        await page.wait(0.7)
                artifacts._trace(ops, {"engine": eng, "stage": "templated_fallback", "result_page": pno,
                             "rescued": bool(results)})
                if not results:
                    break   # rescue failed too → stop this engine
            md = await _serp_markdown(page)
            cur = await _cur_url(page)
            _log(f"{eng} p{pno}: {len(md)}B markdown, {len(results)} result link(s)")
            if not results:
                # Page 1 empty → engine blocked or markup changed (no AI rescue, no conflict).
                # Page ≥2 empty — offset template exhausted / one-shot rescue already spent —
                # → pagination is over. Either way stop WITHOUT appending an empty block
                # (an all-chrome markdown block is pure noise for the SERP reader).
                # The page itself is kept so the cause can be read without another visit.
                saved = artifacts._save_empty_serp(ops, eng, pno, cur, md)
                artifacts._trace(ops, {"engine": eng, "stage": "no_results", "result_page": pno,
                                       "saved": saved.name if saved else ""})
                break
            blocks.append({"engine": eng, "page": pno, "url": cur, "markdown": md, "results": results})
            prev_url = cur
            await browser._dwell(page)   # human read time before the next navigation / close (≤20s)
    except Exception as e:
        _log(f"{eng}: search failed: {e}")
        artifacts._trace(ops, {"engine": eng, "stage": "engine_failed", "error": str(e)})
    finally:
        await browser._close_page(page)  # don't leave the SERP tab open
    return blocks


async def search(query, engines, pages, lang=None, region=None, br=None, fresh=None):
    """Run the query on each engine and return (blocks, ops_path). Engines run with a
    concurrency cap (SEARCH_FETCH_ENGINE_CONCURRENCY, default 1 = sequential) so one Chrome
    window serves them in turn. blocks = [{engine, page, url, markdown}] —
    crawl4ai markdown as-is, no parsing."""
    if br is None:
        br = await browser._connect()
    ops = (artifacts._outdir() / f"search-{artifacts._query_slug(query)}.ops.jsonl").resolve()
    ops.write_text("", encoding="utf-8")
    sem = asyncio.Semaphore(config.ENGINE_CONCURRENCY)

    async def _one(e):
        async with sem:
            try:
                return await asyncio.wait_for(
                    _run_engine(br, e, query, pages, lang, region, ops, fresh),
                    timeout=config.ENGINE_BUDGET)
            except asyncio.TimeoutError:
                _log(f"{e}: engine budget {config.ENGINE_BUDGET}s exceeded — skipping (partial run dropped)")
                artifacts._trace(ops, {"engine": e, "stage": "engine_timeout"})
                return []
            except Exception as ex:
                _log(f"{e}: engine error: {ex}")
                return []

    results = await asyncio.gather(*[_one(e) for e in engines])
    blocks = [b for r in results for b in r]
    _log(f"collected {len(blocks)} SERP page(s) from {len(engines)} engine(s)")
    return blocks, ops
