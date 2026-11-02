"""search_fetch.pacing — request pacing shared by every sf process of the machine.

The Rust runner starts many short-lived sf processes (parallel fetches, one search after
another), so pacing cannot live in one process's memory. Each request first RESERVES a
time slot in a small file under <HOME>/pacing/ (under an exclusive file lock): the slot is
the later of "now" and "previous slot + gap", and the gap is jittered so requests never
form a fixed rhythm. The caller then sleeps until its slot outside the lock, so callers
queue up one gap apart instead of firing together.

Three keys are paced:
  engine:<name>  two queries to the same search engine   (SEARCH_FETCH_SEARCH_GAP, +0–50%)
  host:<host>    two requests to the same host           (SEARCH_FETCH_HOST_GAP, +0–50%)
  nav            any two page navigations of the browser  (SEARCH_FETCH_NAV_GAP, +0–100%)
A single wait never exceeds SEARCH_FETCH_PACE_WAIT_MAX, so pacing can never push a call
past the runner's per-call timeout.
"""

# Async sleep for the browser paths.
import asyncio

# Lock context manager.
import contextlib

# Slot records.
import json

# Operating system (the lock differs on Windows).
import os

# Random jitter.
import random

# File-name cleaning.
import re

# Clock and sync sleep.
import time

# Host of a URL.
import urllib.parse

# Path arithmetic.
from pathlib import Path

# Knobs and the package home.
from . import config

# Shared stderr logger.
from .config import _log

# Directory name under HOME.
PACING_DIRNAME = "pacing"


def host_key(url: str) -> str:
    """Pacing key of a URL's host ('host:example.com'; a leading www. is ignored; '' when there is no host)."""
    # A malformed URL has no host.
    try:
        host = (urllib.parse.urlsplit(url or "").hostname or "").lower()
    except ValueError:
        return ""
    # The local machine is not a remote site: loopback hosts are never paced.
    if host in ("localhost", "::1") or host.startswith("127."):
        return ""
    # www.example.com and example.com are the same site.
    host = host[4:] if host.startswith("www.") else host
    # The key.
    return f"host:{host}" if host else ""


def _slot_file(key: str) -> Path:
    """Slot file of a key under <HOME>/pacing (file-name-safe name)."""
    # Pacing directory.
    d = config.HOME / PACING_DIRNAME
    # Create it once.
    d.mkdir(parents=True, exist_ok=True)
    # Only safe characters in the name.
    return d / (re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:120] + ".json")


def _lock(f, on: bool) -> None:
    """Take (on=True) or release the exclusive lock of an open file: flock on POSIX, a one-byte
    msvcrt lock at offset 0 on Windows (LK_LOCK retries for up to 10 seconds)."""
    # Windows.
    if os.name == "nt":
        import msvcrt
        # The locked byte is the first one, whatever has been read or written.
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_LOCK if on else msvcrt.LK_UNLCK, 1)
        return
    # POSIX.
    import fcntl
    fcntl.flock(f, fcntl.LOCK_EX if on else fcntl.LOCK_UN)


@contextlib.contextmanager
def _locked(path: Path):
    """Open path for read/write under an exclusive lock shared by every sf process."""
    # a+ creates the file and never truncates it.
    with path.open("a+", encoding="utf-8") as f:
        # Lock, use, always unlock.
        _lock(f, True)
        try:
            # The open file, positioned for reading.
            f.seek(0)
            yield f
        finally:
            _lock(f, False)


def jittered(base: float, spread: float, rnd=random.random) -> float:
    """base increased by a random 0–spread fraction (spread 0.5 → base … 1.5 × base)."""
    # Uniform jitter on top of the base.
    return base * (1.0 + spread * rnd())


def reserve(key: str, gap: float, now: float = None) -> float:
    """Reserve the next slot for key at least `gap` seconds after the previous one.
    Returns how long the caller must wait (0 when the slot is now), capped at PACE_WAIT_MAX."""
    # Current wall-clock time (shared across processes).
    now = time.time() if now is None else now
    # Under the key's lock.
    with _locked(_slot_file(key)) as f:
        # Previous slot; a new or unreadable file means there was none.
        try:
            last = float(json.loads(f.read() or "{}").get("slot", float("-inf")))
        except (ValueError, TypeError, AttributeError):
            last = float("-inf")
        # The later of now and one gap after the previous slot.
        slot = max(now, last + gap)
        # Never wait longer than the cap.
        slot = min(slot, now + config.PACE_WAIT_MAX)
        # Record the reservation.
        f.seek(0)
        f.truncate()
        f.write(json.dumps({"slot": slot}))
        # Push it to disk before the lock is released.
        f.flush()
    # Seconds until the slot.
    return max(0.0, slot - now)


def _plan(url: str, engine: str = "") -> list:
    """(key, gap) pairs a navigation to url must respect, coarsest first: the engine gap of a new
    query, the host gap, then the browser-wide gap."""
    # Pairs in reservation order.
    plan = []
    # A new search query.
    if engine:
        plan.append((f"engine:{engine}", jittered(config.SEARCH_GAP, 0.5)))
    # Its host.
    hk = host_key(url)
    if hk:
        plan.append((hk, jittered(config.HOST_GAP, 0.5)))
    # Every navigation.
    plan.append(("nav", jittered(config.NAV_GAP, 1.0)))
    # The plan.
    return plan


def _wait_for(url: str, engine: str, now: float = None) -> float:
    """Reserve the keys in order, each from the time the previous one allows; return the total wait (capped)."""
    # Start time.
    now = time.time() if now is None else now
    # When the request will happen.
    at = now
    # Each key pushes the time further out when it must.
    for key, gap in _plan(url, engine):
        at += reserve(key, gap, now=at)
    # Total wait, never above the cap.
    return min(at - now, config.PACE_WAIT_MAX)


async def before_navigation(url: str, engine: str = "") -> float:
    """Wait (async) until url may be opened; engine names a new query to that search engine. Returns the wait."""
    # How long to wait.
    wait = _wait_for(url, engine)
    # Long waits are worth a log line.
    if wait >= 1.0:
        _log(f"pacing: waiting {wait:.0f}s before {urllib.parse.urlsplit(url).hostname or url}")
    # Sleep without blocking the event loop.
    if wait > 0:
        await asyncio.sleep(wait)
    # The wait.
    return wait


def before_request(url: str) -> float:
    """Wait (blocking) until a plain HTTP request to url may be sent. Returns the wait."""
    # Host gap only: urllib requests are not browser navigations.
    hk = host_key(url)
    # No host, no pacing.
    if not hk:
        return 0.0
    # Reserve the host slot.
    wait = reserve(hk, jittered(config.HOST_GAP, 0.5))
    # Long waits are worth a log line.
    if wait >= 1.0:
        _log(f"pacing: waiting {wait:.0f}s before {hk[5:]}")
    # Sleep.
    if wait > 0:
        time.sleep(wait)
    # The wait.
    return wait
