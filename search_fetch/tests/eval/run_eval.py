#!/usr/bin/env python3
"""Real-outcome evaluation of search_fetch (one round, no retries).

Runs every query in queries.json through `sf search --json` and every URL in urls.json
through `sf fetch --json`, one after another, against the real web, and records what a
writer gets out of it: results per engine stage, freshness markers, fetch success, the
share of prose in the page text, boilerplate markers, document parsing, time and the
peak memory of sf plus its Chrome. State lives in its own SEARCH_FETCH_HOME, so the
user's browser profile is never touched.

Usage: python3 tests/eval/run_eval.py --label baseline [--only search|fetch]
       [--python <venv python>] [--out <dir>]
Output: <out>/<label>/rows.json and summary.json (default out: <JiaWriter>/.tmp/sf-eval).
"""
# Command-line options.
import argparse

# JSON in and out.
import json

# Environment, paths and /proc.
import os

# Pattern matching for the metrics.
import re

# Running sf.
import subprocess

# Exit codes.
import sys

# Background memory sampling.
import threading

# Durations.
import time

# Path arithmetic.
from pathlib import Path

# This directory (queries.json, urls.json).
HERE = Path(__file__).resolve().parent
# search_fetch repository root.
REPO = HERE.parents[1]
# JiaWriter root (where .tmp lives).
SUITE = REPO.parent
# sf.py dev shim of the checkout under test (main() may point it at another checkout).
SF_PY = REPO / "sf.py"
# Seconds allowed for one search.
SEARCH_TIMEOUT = 300
# Seconds allowed for one fetch.
FETCH_TIMEOUT = 240
# Characters a fetch must return to count as content.
MIN_CONTENT_CHARS = 500
# Seconds between memory samples.
SAMPLE_SECONDS = 0.5
# Default pause between two searches of a round (seconds): a person does not search every few seconds.
SEARCH_PAUSE = 60
# Default pause between two fetches of a round (seconds).
FETCH_PAUSE = 10

# Relative-time markers that mean "within the last 24 hours".
FRESH_RE = re.compile(
    r"\b\d{1,2}\s*(?:minutes?|mins?|hours?|hrs?|h)\s+ago\b|\b(?:an?|one)\s+(?:minute|hour)\s+ago\b|"
    r"\d{1,2}\s*(?:分钟|小时)前|刚刚|\b1\s+day\s+ago\b|昨天",
    re.IGNORECASE,
)
# Boilerplate that leaks from navigation, consent banners and login walls.
NOISE_RE = re.compile(
    r"登录|注册|版权所有|Copyright|©|Cookie|cookies|Subscribe|Sign in|Log in|Privacy Policy|隐私政策|"
    r"Terms of (?:Use|Service)|下载\s*APP|扫码|ICP备|Accept all|Skip to (?:main )?content",
    re.IGNORECASE,
)


def load_set(path: Path) -> list:
    """Items of an evaluation set file."""
    # The file holds a JSON list.
    return json.loads(path.read_text(encoding="utf-8"))


def fresh_markers(text: str) -> int:
    """Relative-time markers within 24 hours."""
    # Count the matches.
    return len(FRESH_RE.findall(text or ""))


def noise_markers(text: str) -> int:
    """Boilerplate markers (navigation, consent, login)."""
    # Count the matches.
    return len(NOISE_RE.findall(text or ""))


def prose_ratio(text: str) -> float:
    """Share of characters in prose lines: lines of 40+ characters that are not links or tables."""
    # Non-empty lines.
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    # All characters.
    total = sum(len(ln) for ln in lines)
    # Nothing to measure.
    if total == 0:
        return 0.0
    # Prose: long, not a Markdown link list item, not a table row, not mostly a URL.
    prose = sum(len(ln) for ln in lines
                if len(ln) >= 40 and not ln.startswith(("|", "* [", "- [", "[", "!["))
                and len(re.sub(r"\(https?://[^)]*\)", "", ln)) >= 40)
    # Ratio with three decimals.
    return round(prose / total, 3)


def stage_counts(ops_path) -> dict:
    """engine -> {stage: count} from a search ops.jsonl file ({} when absent)."""
    # Collected counts.
    counts = {}
    # A failed run may not write the file.
    if not ops_path or not Path(ops_path).is_file():
        return counts
    # One JSON record per line.
    for line in Path(ops_path).read_text(encoding="utf-8").splitlines():
        # Skip broken lines.
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        # Only records that name a stage.
        if "stage" not in rec:
            continue
        # Per-engine counter.
        per = counts.setdefault(rec.get("engine", "?"), {})
        # Increment the stage.
        per[rec["stage"]] = per.get(rec["stage"], 0) + 1
    # The counts.
    return counts


def _children(pid: int) -> list:
    """Direct children of pid (Linux /proc)."""
    # Each thread lists its children.
    out = []
    # Walk the threads of the process.
    for task in Path(f"/proc/{pid}/task").glob("*"):
        # Read the children list; the process may have ended.
        try:
            out += [int(c) for c in (task / "children").read_text().split()]
        except OSError:
            continue
    # Child pids.
    return out


def _rss_kb(pid: int) -> int:
    """Resident memory of pid in kB (0 when it is gone)."""
    # VmRSS line of /proc/<pid>/status.
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            # The resident set size.
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        return 0
    # Kernel threads have no VmRSS.
    return 0


def tree_rss_mb(root: int, needle: str) -> float:
    """MB resident in root's process tree plus every process whose command line contains needle."""
    # Pids to count.
    pids = set()
    # Breadth-first walk of the tree.
    todo = [root]
    # Visit each pid once.
    while todo:
        # Next pid.
        pid = todo.pop()
        # Skip repeats.
        if pid in pids:
            continue
        # Count it.
        pids.add(pid)
        # Queue its children.
        todo += _children(pid)
    # Chrome may be detached from sf: find it by its profile path.
    for entry in Path("/proc").iterdir():
        # Only numeric entries are processes.
        if not entry.name.isdigit():
            continue
        # Command line with NUL separators.
        try:
            cmd = (entry / "cmdline").read_bytes().decode("utf-8", "replace")
        except OSError:
            continue
        # Processes that use the evaluation home.
        if needle and needle in cmd:
            pids.add(int(entry.name))
    # Sum in MB, one decimal.
    return round(sum(_rss_kb(p) for p in pids) / 1024, 1)


def run_sf(python: str, args: list, cwd: Path, env: dict, needle: str, timeout: int) -> dict:
    """Run sf once; return exit code, seconds, peak MB, stdout and stderr."""
    # Command: the venv python running the dev shim (SF_PY selects another checkout).
    cmd = [python, str(SF_PY), *args]
    # Start time.
    started = time.monotonic()
    # Start the process; output goes to pipes.
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # Highest memory seen.
    peak = [0.0]
    # Sampler stop flag.
    done = threading.Event()

    def sample():
        # Sample until the process ends.
        while not done.is_set():
            # Keep the maximum.
            peak[0] = max(peak[0], tree_rss_mb(proc.pid, needle))
            # Wait for the next sample.
            done.wait(SAMPLE_SECONDS)

    # Sampler thread.
    sampler = threading.Thread(target=sample, daemon=True)
    # Start sampling.
    sampler.start()
    # Wait with a bound; a hung run is killed, never retried.
    try:
        out, err = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        code = "timeout"
    # Stop sampling.
    done.set()
    # Join the sampler.
    sampler.join()
    # The run.
    return {"exit": code, "seconds": round(time.monotonic() - started, 1), "peak_mb": peak[0],
            "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace")}


def _newest_ops(cwd: Path, since: float):
    """Newest search ops.jsonl written in cwd after since (None when there is none)."""
    # Candidate files.
    files = [p for p in (cwd / ".search_fetchres").glob("search-*.ops.jsonl") if p.stat().st_mtime >= since]
    # Most recent one.
    return max(files, key=lambda p: p.stat().st_mtime) if files else None


def search_row(item: dict, python: str, cwd: Path, env: dict, needle: str) -> dict:
    """Metrics of one search query."""
    # Arguments: JSON output, page 1, optional time filter.
    args = ["search", item["query"], "--json", "--pages", "1"]
    # Freshness filter for the news group.
    if item.get("fresh"):
        args += ["--fresh", item["fresh"]]
    # Start time for finding the ops file.
    since = time.time() - 1
    # Run it.
    run = run_sf(python, args, cwd, env, needle, SEARCH_TIMEOUT)
    # Parse the JSON contract.
    try:
        blocks = json.loads(run["stdout"]).get("blocks", [])
    except ValueError:
        blocks = []
    # All result links.
    results = [r for b in blocks for r in b.get("results") or []]
    # SERP text for the freshness markers.
    serp = "\n".join(b.get("markdown", "") for b in blocks)
    # The row.
    return {
        "id": item["id"], "group": item["group"], "kind": "search", "exit": run["exit"],
        "seconds": run["seconds"], "peak_mb": run["peak_mb"], "results": len(results),
        "engines_with_results": len({b.get("engine") for b in blocks if b.get("results")}),
        "stages": stage_counts(_newest_ops(cwd, since)),
        "fresh_markers": fresh_markers(serp) if item.get("fresh") else None,
        "llm_missing": "missing local-LLM config" in run["stderr"],
    }


def fetch_row(item: dict, python: str, cwd: Path, env: dict, needle: str) -> dict:
    """Metrics of one URL fetch."""
    # Arguments: JSON output, wait for documents.
    args = ["fetch", item["url"], "--json", "--sync"]
    # Run it.
    run = run_sf(python, args, cwd, env, needle, FETCH_TIMEOUT)
    # Parse the JSON contract.
    try:
        payload = json.loads(run["stdout"])
    except ValueError:
        payload = {}
    # Page text.
    md = payload.get("markdown", "") or ""
    # Failure class from stderr and exit code.
    if run["exit"] == "timeout":
        status = "timeout"
    elif "blocked:" in run["stderr"]:
        status = "blocked"
    elif run["exit"] != 0:
        status = "error"
    elif len(md) < MIN_CONTENT_CHARS:
        status = "thin"
    else:
        status = "ok"
    # The row.
    return {
        "id": item["id"], "group": item["group"], "kind": "fetch", "doc": bool(item.get("doc")),
        "exit": run["exit"], "status": status, "seconds": run["seconds"], "peak_mb": run["peak_mb"],
        "chars": len(md), "prose_ratio": prose_ratio(md), "noise": noise_markers(md),
    }


def summarize(rows: list) -> dict:
    """Totals over all rows."""
    # Split by kind.
    searches = [r for r in rows if r["kind"] == "search"]
    # Fetches.
    fetches = [r for r in rows if r["kind"] == "fetch"]
    # Fresh-day queries.
    fresh = [r for r in searches if r["fresh_markers"] is not None]
    # Successful fetches.
    ok = [r for r in fetches if r["status"] == "ok"]
    # Document fetches.
    docs = [r for r in fetches if r["doc"]]
    # Stage totals over all engines.
    stages = {}
    # Add each search's stages.
    for r in searches:
        for per in r["stages"].values():
            for stage, n in per.items():
                stages[stage] = stages.get(stage, 0) + n
    # Ratio helper with three decimals.
    ratio = lambda a, b: round(a / b, 3) if b else None  # noqa: E731
    # The summary.
    return {
        "search_queries": len(searches),
        "search_with_results": ratio(sum(1 for r in searches if r["results"] > 0), len(searches)),
        "search_results_avg": ratio(sum(r["results"] for r in searches), len(searches)),
        "search_stages": stages,
        "search_llm_missing": sum(1 for r in searches if r["llm_missing"]),
        "fresh_queries_with_markers": ratio(sum(1 for r in fresh if r["fresh_markers"]), len(fresh)),
        "fetch_urls": len(fetches),
        "fetch_ok": ratio(len(ok), len(fetches)),
        "fetch_status": {s: sum(1 for r in fetches if r["status"] == s) for s in sorted({r["status"] for r in fetches})},
        "doc_ok": ratio(sum(1 for r in docs if r["status"] == "ok"), len(docs)),
        "prose_ratio_avg": ratio(sum(r["prose_ratio"] for r in ok), len(ok)),
        "noise_avg": ratio(sum(r["noise"] for r in ok), len(ok)),
        "search_seconds_avg": ratio(sum(r["seconds"] for r in searches), len(searches)),
        "fetch_seconds_avg": ratio(sum(r["seconds"] for r in fetches), len(fetches)),
        "peak_mb": max((r["peak_mb"] for r in rows), default=0),
    }


def main(argv=None) -> int:
    # Options.
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # Name of this round (baseline, after, ...).
    ap.add_argument("--label", required=True)
    # Only one half of the set.
    ap.add_argument("--only", choices=["search", "fetch"])
    # Interpreter with the engine's dependencies.
    ap.add_argument("--python", default=str(REPO / "home" / "venv" / "bin" / "python3"))
    # Output root.
    ap.add_argument("--out", default=str(SUITE / ".tmp" / "sf-eval"))
    # sf.py of the checkout to evaluate (default: this one).
    ap.add_argument("--sf", default=str(REPO / "sf.py"))
    # Pauses between calls, so every checkout is evaluated at the same human pace.
    ap.add_argument("--search-pause", type=float, default=SEARCH_PAUSE)
    ap.add_argument("--fetch-pause", type=float, default=FETCH_PAUSE)
    # Parse.
    opts = ap.parse_args(argv)
    # Every run of this round uses that checkout.
    global SF_PY
    # Absolute path.
    SF_PY = Path(opts.sf).resolve()
    # This round's directory: results, state and the working folder.
    out = Path(opts.out) / opts.label
    # Working folder for .search_fetchres.
    cwd = out / "work"
    # Create it.
    cwd.mkdir(parents=True, exist_ok=True)
    # Separate state home: fresh Chrome profile, the user's stays untouched.
    home = out / "home"
    # Environment of every run: unattended, own home.
    env = {**os.environ, "SEARCH_FETCH_HOME": str(home), "SEARCH_FETCH_NO_HUMAN": "1"}
    # Collected rows.
    rows = []
    # Searches.
    if opts.only in (None, "search"):
        for i, item in enumerate(load_set(HERE / "queries.json")):
            # Human pace between searches (none before the first).
            if i:
                time.sleep(opts.search_pause)
            # One run per query.
            rows.append(search_row(item, opts.python, cwd, env, str(home)))
            # Progress line.
            print(f"search {item['id']}: {rows[-1]['results']} results, {rows[-1]['seconds']}s", flush=True)
    # Fetches.
    if opts.only in (None, "fetch"):
        for i, item in enumerate(load_set(HERE / "urls.json")):
            # Pause between fetches (none before the first).
            if i:
                time.sleep(opts.fetch_pause)
            # One run per URL.
            rows.append(fetch_row(item, opts.python, cwd, env, str(home)))
            # Progress line.
            print(f"fetch {item['id']}: {rows[-1]['status']}, {rows[-1]['chars']} chars, {rows[-1]['seconds']}s", flush=True)
    # End the Chrome session of this round.
    run_sf(opts.python, ["browser", "stop"], cwd, env, str(home), 60)
    # Save the rows.
    (out / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    # Save and print the summary.
    summary = summarize(rows)
    # Summary file.
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    # On stdout too.
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    # Success.
    return 0


if __name__ == "__main__":
    # Exit with main's code.
    sys.exit(main())
