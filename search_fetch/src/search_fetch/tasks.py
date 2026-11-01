"""search_fetch.tasks — detached background tasks for OCR and ASR.

Search/fetch runs as many short-lived subprocesses (the Rust runner spawns one
per call), so "background" cannot mean a thread — it means a DETACHED WORKER
PROCESS whose state lives on disk, under <results>/tasks/:

    <id>.json    task record {id, kind, payload, status, created, …}
    <id>.out.md  the worker's text output (transcription / OCR markdown)
    <id>.log     the worker's stderr (troubleshooting)

`enqueue` writes the record and spawns `sf.py worker <id>.json` detached
(start_new_session); the fetch that triggered it returns immediately. Before
the knowledge base is built, the caller runs the BARRIER `sf.py tasks wait
--timeout N [--since ISO]` which polls until every matching task is terminal
or the timeout runs out — a hung HF Space costs at most the timeout, never the
run. Stale non-terminal tasks (older than SEARCH_FETCH_TASK_STALE, e.g. a
worker killed by a reboot) are reported failed instead of blocking forever.
"""

# Task records.
import json

# Environment and pid.
import os

# Detached workers.
import subprocess

# The current interpreter.
import sys

# Polling the barrier.
import time

# Task ids.
import uuid

# Timestamps in UTC.
from datetime import datetime, timezone

# Path arithmetic.
from pathlib import Path

# Results directory, atomic writes and knobs.
from . import artifacts, config

# Shared stderr logger.
from .config import _log

# Seconds between barrier polls.
_WAIT_POLL = 2
# Statuses that are still running.
_OPEN = ("pending", "running")


def _tasks_dir() -> Path:
    """./.search_fetchres/tasks, created on demand."""
    # Under the results directory of the working folder.
    d = artifacts._outdir() / config.TASKS_DIRNAME
    # Create it once.
    d.mkdir(parents=True, exist_ok=True)
    # The directory.
    return d


def _now_iso() -> str:
    """Current UTC time, ISO 8601 to the second."""
    # Timezone-aware, so comparisons never depend on the host's offset.
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write_record(path: Path, rec: dict):
    """Write a task record atomically, so the barrier never reads a half-written file."""
    # JSON with a small indent for readability.
    artifacts._write_atomic(path, json.dumps(rec, ensure_ascii=False, indent=1))


def enqueue(kind: str, payload: dict) -> str:
    """Create a task record and spawn its detached worker. Returns the task id.
    kind ∈ ocr | asr. The worker re-runs THIS package as `python -m search_fetch`
    under the SAME interpreter, in the SAME cwd (the results dir is cwd-relative).
    PYTHONPATH is prepended with the package's parent dir so the child resolves
    the SAME copy no matter how the parent was launched (dev sf.py sys.path
    insert, installed venv, PyApp release binary) — one respawn path for all."""
    # Kind plus 10 random hex digits.
    tid = f"{kind}-{uuid.uuid4().hex[:10]}"
    # Spool directory.
    d = _tasks_dir()
    # Record path.
    rec_path = d / f"{tid}.json"
    # The pending record exists before the worker starts.
    _write_record(rec_path, {"id": tid, "kind": kind, "payload": payload,
                             "status": "pending", "created": _now_iso()})
    # Directory that contains the search_fetch package.
    pkg_parent = Path(__file__).resolve().parents[1]
    # Child environment.
    env = dict(os.environ)
    # The package's parent first on the import path.
    env["PYTHONPATH"] = os.pathsep.join(
        [str(pkg_parent)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    # The worker's log.
    log = (d / f"{tid}.log").open("ab")
    # Spawn detached; the parent closes its copy of the log handle.
    try:
        subprocess.Popen(
            [sys.executable, "-m", "search_fetch", "worker", str(rec_path)],
            stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True, cwd=str(Path.cwd()), env=env)
    finally:
        # The child holds its own inherited handle.
        log.close()
    # Progress line.
    _log(f"task {tid} enqueued ({kind})")
    # The id.
    return tid


def _run_task(rec: dict) -> str:
    """Text output of one task (raises on failure). Heavy modules are imported here, in the worker."""
    # OCR of a PDF or an image.
    if rec["kind"] == "ocr":
        # Imported lazily: enqueueing must stay instant.
        from . import docparse
        # The validated file.
        data = Path(rec["payload"]["bin"]).read_bytes()
        # PDFs are rasterized page by page; images go straight to OCR.
        if rec["payload"]["kind"] == "pdf":
            text = docparse._ocr_pdf(data)
        else:
            text = docparse._ocr_image_bytes(data, rec["payload"].get("suffix", ".png"))
        # An empty result is a failure, not a silent success.
        if not text:
            raise RuntimeError("OCR produced no text")
        # The text.
        return text
    # Speech recognition of a short media file.
    if rec["kind"] == "asr":
        # Imported lazily for the same reason.
        from . import media
        # The transcript.
        return media.transcribe(rec["payload"])
    # Anything else is a bug in the caller.
    raise RuntimeError(f"unknown task kind: {rec['kind']}")


def run_worker(rec_path: str) -> int:
    """Worker entry (`sf.py worker <id>.json`): execute ONE task to completion."""
    # Record file.
    path = Path(rec_path)
    # `tasks clear` (a new run) can delete the record between enqueue and worker startup.
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as ex:
        # That is a normal shutdown signal, not a crash.
        _log(f"worker: task record {path.name} unreadable ({ex}) — exiting")
        return 1
    # Mark it running.
    rec.update(status="running", pid=os.getpid(), started=_now_iso())
    # Persist the status.
    _write_record(path, rec)
    # Output file next to the record.
    out_path = path.with_name(f"{rec['id']}.out.md")

    def _still_wanted() -> bool:
        # A surviving worker from an OLD run must not resurrect a record that `tasks clear`
        # deleted: its material would leak into the new run's knowledge base at the barrier.
        if path.exists():
            return True
        # Say why the result is dropped.
        _log(f"task {rec['id']}: record was cleared while running — discarding result")
        return False

    # Run, save, and record the outcome.
    try:
        # The task's text.
        text = _run_task(rec)
        # Cleared while running.
        if not _still_wanted():
            return 1
        # Raw output.
        artifacts._write_atomic(out_path, text)
        # A standard fit/raw artifact too, readable by the caller like any fetched page.
        src = rec["payload"].get("source", "")
        # Saved page.
        fit, _raw = artifacts._save_results(src or rec["id"], src, {"fit": text, "raw": text},
                                            {"title": rec["payload"].get("title", ""), "task": rec["id"]})
        # Ledger row.
        artifacts._append_index(rec["kind"], src or rec["id"], [fit, out_path], src)
        # Done record.
        rec.update(status="done", chars=len(text), out=str(out_path), finished=_now_iso())
        # Re-check right before the final write: a `tasks clear` during the writes above wins.
        if not _still_wanted():
            return 1
        # Persist.
        _write_record(path, rec)
        # Success.
        return 0
    except Exception as ex:
        # Any failure of the task becomes a failed record (unless the record was cleared).
        if not _still_wanted():
            return 1
        # Bounded error text.
        rec.update(status="failed", error=str(ex)[:300], finished=_now_iso())
        # Persist.
        _write_record(path, rec)
        # Log line.
        _log(f"task {rec['id']} failed: {str(ex)[:160]}")
        # Failure.
        return 1


def _load(path: Path) -> dict:
    """A task record ({} when it is unreadable or not JSON)."""
    # A record being replaced or deleted reads as empty.
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _created_ts(rec: dict) -> float:
    """Creation time of a record as a Unix timestamp (0 when missing or malformed)."""
    # fromisoformat raises ValueError on bad text and TypeError on a non-string.
    try:
        return datetime.fromisoformat(rec.get("created", "")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _cutoff(since: str) -> float:
    """Timestamp of an ISO `--since` value (naive times are UTC); 0 when empty or malformed."""
    # No filter.
    if not since:
        return 0.0
    # Parse; a bad value disables the filter.
    try:
        dt = datetime.fromisoformat(since)
    except ValueError:
        return 0.0
    # Records are written in UTC, so a naive value is read as UTC too.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    # The timestamp.
    return dt.timestamp()


def snapshot(since: str = "") -> list:
    """All task records (created >= since when given), stale ones marked failed."""
    # Creation-time filter.
    cutoff = _cutoff(since)
    # Records.
    out = []
    # Spool directory (read-only here, so it is not created).
    d = artifacts._outdir() / config.TASKS_DIRNAME
    # No spool yet.
    if not d.is_dir():
        return out
    # One time for the whole scan.
    now = time.time()
    # Each record file.
    for p in sorted(d.glob("*.json")):
        # Parsed record.
        rec = _load(p)
        # Skip unreadable or foreign files.
        if not rec.get("id"):
            continue
        # Skip records older than the cutoff.
        if cutoff and _created_ts(rec) < cutoff:
            continue
        # A worker that never finished (killed, reboot) is reported failed instead of blocking forever.
        if rec.get("status") in _OPEN and now - _created_ts(rec) > config.TASK_STALE:
            rec["status"] = "failed"
            rec["error"] = "stale (worker never finished)"
        # Keep it.
        out.append(rec)
    # All records.
    return out


def wait_all(timeout: float = None, since: str = "") -> dict:
    """The KB barrier: poll until every matching task is terminal or `timeout`
    (default SEARCH_FETCH_TASK_WAIT) runs out. Returns {done, failed, pending}
    with each task's kind/source/out so the caller can fold the finished text
    into the corpus and log exactly what was dropped."""
    # Budget in seconds.
    budget = config.TASK_WAIT if timeout is None else timeout
    # Absolute deadline.
    deadline = time.monotonic() + budget
    # Poll until nothing is open or the budget is spent.
    while any(r.get("status") in _OPEN for r in snapshot(since)) and time.monotonic() < deadline:
        time.sleep(_WAIT_POLL)
    # Report grouped by outcome.
    rep = {"done": [], "failed": [], "pending": []}
    # One final snapshot.
    for r in snapshot(since):
        # Open tasks count as pending.
        key = {"done": "done", "failed": "failed"}.get(r.get("status"), "pending")
        # The fields the caller needs, plus source and title from the payload.
        rep[key].append({k: r.get(k) for k in ("id", "kind", "status", "created", "chars", "out", "error")}
                        | {"source": r.get("payload", {}).get("source", ""),
                           "title": r.get("payload", {}).get("title", "")})
    # Say what the timeout dropped.
    if rep["pending"]:
        _log(f"tasks wait: timeout after {budget:.0f}s — "
             f"{len(rep['pending'])} task(s) still open (dropped from this KB build)")
    # The report.
    return rep


def clear() -> int:
    """Delete every task record/output (a fresh run's clean slate). Returns count."""
    # Spool directory.
    d = artifacts._outdir() / config.TASKS_DIRNAME
    # Files removed.
    n = 0
    # Nothing to clear without a spool.
    if d.is_dir():
        # Every file in it.
        for p in d.iterdir():
            # A file already gone is not an error.
            try:
                p.unlink()
                n += 1
            except OSError:
                pass
    # How many were removed.
    return n
