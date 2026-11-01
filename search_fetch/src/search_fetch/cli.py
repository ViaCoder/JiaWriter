"""search_fetch.cli — the one script-invocation surface (no interactive UI).

    sf.py search "<query>" [--engine …] [--pages N] [--lang xx] [--region yy] [--fresh day|week|month|year] [--json]
    sf.py fetch <url> [--query …] [--json] [--sync]
    sf.py ingest <dir> [--json]                   (local materials folder → corpus text)
    sf.py selftest [--engine …] [--json]
    sf.py kb <index|retrieve-multi|retire|query> … (the RAG sidecar, same args as before)
    sf.py tasks <wait|list|clear> [--timeout N] [--since ISO] [--json]
    sf.py browser <stop|status> [--json]          (close this run's tabs / report the bridge)
    sf.py bridge <install|status> [--json]        (set up / check the Chrome extension bridge)
    sf.py bridge-host <origin>                    (internal: started by Chrome via native messaging)
    sf.py worker <task.json>                      (internal: detached OCR/ASR worker)

WriterAgent (WA_SF) runs `sf search` / `sf fetch` as a child process; this CLI is the one
and only invocation surface.

Each command imports its modules inside its handler: `sf tasks list` must not pay
for loading crawl4ai and the browser stack.
"""

# Option parsing.
import argparse

# The browser stack is async.
import asyncio

# Machine output.
import json

# stdout/stderr and argv.
import sys

# Engine roster and session paths.
from . import config

# Shared stderr logger.
from .config import _log

# Canned selftest query for Chinese engines.
_SELFTEST_QUERY_ZH = "全球气候变化 2026"
# Canned selftest query for the others.
_SELFTEST_QUERY_EN = "climate change report 2026"
# Engines that get the Chinese query.
_ZH_ENGINES = ("baidu", "sogou", "bing_cn")
# Results page 1 must have at least this many links in the selftest.
_SELFTEST_MIN_RESULTS = 5


def _engines(spec: str) -> list:
    """Engine names from a comma list; SystemExit naming the unknown ones."""
    # Trimmed, lower-case, non-empty names.
    eng = [e.strip().lower() for e in spec.split(",") if e.strip()]
    # Names not in the roster.
    bad = [e for e in eng if e not in config.ENGINES]
    # Usage error (argparse-style exit).
    if bad:
        raise SystemExit("unknown engine(s): " + ", ".join(bad))
    # The engines.
    return eng


def _cmd_search(a) -> int:
    """`sf search`: run the engines, save the SERP, print JSON or markdown."""
    # Browser stack and result writers.
    from . import artifacts, browser, known_urls

    # The search path.
    from . import search as search_mod
    # Validated engines.
    eng = _engines(a.engine)

    async def run():
        # Shared Chrome of this run.
        br = await browser._connect()
        # All engines, pages, language/region and time filter.
        blocks, ops = await search_mod.search(a.query, eng, max(1, a.pages), a.lang, a.region, br, fresh=a.fresh)
        # Every result link joins the run's known-URL ledger (enforced only with SEARCH_FETCH_ONLY_KNOWN_URLS=1).
        known_urls.register(r.get("u", "") for b in blocks for r in b.get("results", []) or [])
        # Human-readable SERP file.
        p = artifacts._save_search(a.query, blocks, ops)
        # Ledger row.
        artifacts._append_index("search", a.query, [p, ops])
        # Machine contract or markdown.
        sys.stdout.write(artifacts._blocks_json(a.query, blocks) if a.json else artifacts._format_blocks(a.query, blocks))
        # Where it was saved.
        _log(f"saved {p}")

    # Run the async part.
    asyncio.run(run())
    # Success.
    return 0


def _cmd_fetch(a) -> int:
    """`sf fetch`: render one URL (or document) to markdown."""
    # The fetch ladder.
    from .fetch import run_fetch
    # OCR/ASR deferred unless --sync.
    asyncio.run(run_fetch(a.url, query=a.query, as_json=a.json, defer=not a.sync))
    # Success.
    return 0


def _cmd_ingest(a) -> int:
    """`sf ingest`: parse a local materials folder."""
    # Materials parser.
    from . import ingest
    # Its exit code.
    return ingest.run(a.dir, a.json)


def _selftest_row(n1: int, n2: int, eng: str) -> dict:
    """Selftest verdict for one engine from its page-1 and page-2 result counts."""
    # OK means enough parsed results on page 1.
    return {"engine": eng, "ok": n1 >= _SELFTEST_MIN_RESULTS, "p1_results": n1, "p2_results": n2, "paginated": n2 > 0}


def _cmd_selftest(a) -> int:
    """`sf selftest`: canned query per engine; exit 2 when any engine fails."""
    # Browser stack and the search path.
    from . import browser
    from . import search as search_mod

    async def run() -> list:
        # Shared Chrome.
        br = await browser._connect()
        # One engine or all of them.
        targets = [a.engine] if a.engine else list(config.ENGINES)
        # Rows.
        report = []
        # Each engine.
        for eng in targets:
            # Language-appropriate query.
            q = _SELFTEST_QUERY_ZH if eng in _ZH_ENGINES else _SELFTEST_QUERY_EN
            # A failing engine is a row, not an abort.
            try:
                # Two pages, to check pagination.
                blocks, _ = await search_mod.search(q, [eng], 2, None, None, br)
                # Results per page.
                n1 = sum(len(b.get("results", [])) for b in blocks if b.get("page") == 1)
                n2 = sum(len(b.get("results", [])) for b in blocks if b.get("page") == 2)
                # Verdict.
                report.append(_selftest_row(n1, n2, eng))
            except Exception as ex:
                # Bounded error text.
                report.append({"engine": eng, "ok": False, "error": str(ex)[:160]})
        # All rows.
        return report

    # Run the engines.
    report = asyncio.run(run())
    # Overall verdict.
    all_ok = all(r.get("ok") for r in report)
    # JSON for machines.
    if a.json:
        sys.stdout.write(json.dumps({"ok": all_ok, "engines": report}, ensure_ascii=False, indent=1))
    else:
        # One line per engine.
        for r in report:
            sys.stdout.write(f"{'OK  ' if r.get('ok') else 'FAIL'} {r['engine']}: "
                             f"p1={r.get('p1_results', '-')} p2={r.get('p2_results', '-')} "
                             f"{r.get('error', '')}\n")
    # 2 marks a failed contract.
    return 0 if all_ok else 2


def _cmd_tasks(a) -> int:
    """`sf tasks wait|list|clear`."""
    # The spool.
    from . import tasks
    # The KB barrier.
    if a.op == "wait":
        # Wait for the matching tasks.
        rep = tasks.wait_all(timeout=a.timeout, since=a.since or "")
        # Full report or a one-line count.
        sys.stdout.write(json.dumps(rep, ensure_ascii=False, indent=1) if a.json else
                         f"done={len(rep['done'])} failed={len(rep['failed'])} pending={len(rep['pending'])}\n")
        # Success.
        return 0
    # Listing.
    if a.op == "list":
        # Records.
        recs = tasks.snapshot(a.since or "")
        # JSON for machines.
        if a.json:
            sys.stdout.write(json.dumps(recs, ensure_ascii=False, indent=1))
        else:
            # One line per task.
            for r in recs:
                sys.stdout.write(f"{r.get('id')}  {r.get('status'):8}  {r.get('payload', {}).get('source', '')}\n")
        # Success.
        return 0
    # Clearing (the only remaining op).
    n = tasks.clear()
    # Count.
    sys.stdout.write(f"cleared {n} file(s)\n")
    # Success.
    return 0


def _cmd_browser(a) -> int:
    """`sf browser stop|status`: close this run's tabs in the user's Chrome, or report the bridge."""
    # Page handling and the bridge.
    from . import bridge, browser
    # Stop: close the tabs tagged with this run id.
    if a.op == "stop":
        # Report.
        rep = browser.stop_browser()
        # JSON or a sentence.
        sys.stdout.write(json.dumps(rep) + "\n" if a.json else f"closed {rep['closed']} tab(s)\n")
        # Closing nothing is fine (Chrome may be closed already).
        return 0
    # Status: the bridge connection.
    sys.stdout.write(json.dumps(bridge.status()) + "\n")
    # Success.
    return 0


def _cmd_bridge(a) -> int:
    """`sf bridge install|status`: set up the Chrome extension bridge, or report it."""
    # The bridge.
    from . import bridge
    # Status only.
    if a.op == "status":
        st = bridge.status()
        sys.stdout.write(json.dumps(st) + "\n")
        return 0 if st["connected"] else 1
    # Install: extension copy, launcher and host manifests.
    rep = bridge.install()
    # JSON for machines.
    if a.json:
        sys.stdout.write(json.dumps(rep) + "\n")
        return 0
    # Steps for a person.
    sys.stdout.write(
        "search_fetch bridge installed.\n"
        f"  extension folder : {rep['extension_dir']}\n"
        f"  extension id     : {rep['extension_id']}\n"
        + "".join(f"  host manifest    : {m}\n" for m in rep["manifests"]) +
        "Next, once in Chrome: open chrome://extensions, turn on Developer mode, click "
        "'Load unpacked' and choose the extension folder above. Keep Chrome open while sf runs;\n"
        "check with `sf bridge status`.\n")
    # Success.
    return 0


def _guarded(fn, *args) -> int:
    """Run a command; the Rust runner expects `[search_fetch] failed: …` + rc 1, never a traceback."""
    # Usage errors keep their own exit.
    try:
        return fn(*args)
    except SystemExit:
        raise
    except Exception as e:
        # One log line.
        _log(f"failed: {e}")
        # Failure.
        return 1


def _parser() -> argparse.ArgumentParser:
    """The argparse tree of every command except kb and worker."""
    # Top level with the module docstring as help.
    ap = argparse.ArgumentParser(prog="sf", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # One required subcommand.
    sub = ap.add_subparsers(dest="cmd", required=True)
    # fetch.
    pf = sub.add_parser("fetch")
    pf.add_argument("url")
    pf.add_argument("--json", action="store_true", help="emit {final_url, markdown} as JSON")
    pf.add_argument("--query", default=None,
                    help="BM25 relevance query: fit markdown keeps the query-relevant content "
                         "(deterministic bounding only — all summarising stays with the LLM reader)")
    pf.add_argument("--sync", action="store_true", help="run OCR/ASR inline instead of as background tasks")
    # ingest.
    pg = sub.add_parser("ingest",
                        help="parse every supported document in a local materials folder "
                             "(pdf/docx/pptx/xlsx/csv/txt/md; scanned pages via deferred OCR) "
                             "into corpus text with per-file 来源 markers")
    pg.add_argument("dir")
    pg.add_argument("--json", action="store_true", help="emit {dir, files:[{file,kind,status,chars}], corpus} as JSON")
    # search.
    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--engine", default=",".join(config.DEFAULT_ENGINES))
    ps.add_argument("--pages", type=int, default=1)
    ps.add_argument("--lang", default=None)
    ps.add_argument("--region", default=None)
    ps.add_argument("--fresh", default=None, choices=["day", "week", "month", "year"],
                    help="engine-native time-range filter for the results (best-effort per engine)")
    ps.add_argument("--json", action="store_true",
                    help="emit {query, blocks:[{engine,page,url,results,markdown}]} as JSON "
                         "(clean DOM hrefs; the machine-consumer contract)")
    # selftest.
    pt = sub.add_parser("selftest",
                        help="SERP contract self-test: canned query per engine; verifies submit, "
                             ">=5 parsed results on p1, and pagination to p2 — run after a search "
                             "engine frontend change to locate the broken layer")
    pt.add_argument("--engine", default=None, help="test only this engine (default: all)")
    pt.add_argument("--json", action="store_true")
    # tasks.
    pk = sub.add_parser("tasks", help="background OCR/ASR task spool")
    pk.add_argument("op", choices=["wait", "list", "clear"])
    pk.add_argument("--timeout", type=float, default=None, help="barrier budget in seconds (default SEARCH_FETCH_TASK_WAIT)")
    pk.add_argument("--since", default=None, help="only tasks created at/after this ISO timestamp (a run's own tasks)")
    pk.add_argument("--json", action="store_true")
    # browser.
    pb = sub.add_parser("browser", help="this run's pages in the user's Chrome: `stop` closes the run's "
                                        "tabs; `status` reports the extension bridge")
    pb.add_argument("op", choices=["stop", "status"])
    pb.add_argument("--json", action="store_true")
    # bridge.
    pr = sub.add_parser("bridge", help="the Chrome extension bridge: `install` sets it up for this user's "
                                       "Chrome/Chromium, `status` reports whether the extension is connected")
    pr.add_argument("op", choices=["install", "status"])
    pr.add_argument("--json", action="store_true")
    # The tree.
    return ap


# Handlers by subcommand name.
_COMMANDS = {"search": _cmd_search, "fetch": _cmd_fetch, "ingest": _cmd_ingest,
             "selftest": _cmd_selftest, "tasks": _cmd_tasks, "browser": _cmd_browser, "bridge": _cmd_bridge}


def main(argv=None) -> int:
    """Entry: kb and worker are delegated before argparse; everything else is parsed here."""
    # Arguments without the program name.
    argv = sys.argv[1:] if argv is None else argv
    # kb keeps its own argparse, so its flags never collide with ours.
    if argv and argv[0] == "kb":
        # Knowledge-base sidecar.
        from . import kb
        # Same failure contract as the other commands.
        return _guarded(kb.main, argv[1:])
    # The detached OCR/ASR worker.
    if argv and argv[0] == "worker":
        # Exactly one record path.
        if len(argv) != 2:
            sys.stderr.write("usage: sf.py worker <task.json>\n")
            return 2
        # Task spool.
        from . import tasks
        # Same failure contract.
        return _guarded(tasks.run_worker, argv[1])
    # The native messaging host, started by Chrome with the caller's origin as its argument.
    if argv and argv[0] == "bridge-host":
        # The bridge.
        from . import bridge
        # Same failure contract.
        return _guarded(bridge.host_main, argv[1:])
    # Parse the rest.
    a = _parser().parse_args(argv)
    # Run the chosen command.
    return _guarded(_COMMANDS[a.cmd], a)
