#!/usr/bin/env python3
"""Request pacing (search_fetch.pacing) — stdlib only, no network, no browser.

Covers host keys (loopback never paced), jitter bounds, slot reservation (gap, cap,
corrupt slot file), the reservation order of a navigation, the async and blocking
waits, and a cross-process run: three processes reserving the same key get slots at
least one gap apart. HOME is a scratch dir under tests/tmp.
Run: python3 tests/test_pacing.py  (or python3 -m unittest tests/test_pacing.py)
"""
# Async entry for before_navigation.
import asyncio

# Parallel reservations in child processes.
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Import the package from ./src.
_SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(_SRC))
from search_fetch import config, pacing  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


class PacingTest(unittest.TestCase):
    def setUp(self):
        # Fresh HOME per test.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="pacing-", dir=str(_TMP_ROOT)))
        self.patch = mock.patch.object(config, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        # Restore HOME and remove the scratch dir.
        self.patch.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_host_key(self):
        # www. is ignored, case folded; loopback and junk have no key.
        self.assertEqual(pacing.host_key("https://WWW.Example.com/a"), "host:example.com")
        self.assertEqual(pacing.host_key("https://news.example.com:8443/"), "host:news.example.com")
        for url in ("http://127.0.0.1:9000/x", "http://localhost/", "http://[::1]/", "not a url", "", "http://[bad"):
            self.assertEqual(pacing.host_key(url), "", url)

    def test_slot_file_and_lock(self):
        # Unsafe characters are replaced; the lock yields a readable file.
        p = pacing._slot_file("host:a/b?c")
        self.assertEqual((p.parent, p.name), (self.home / "pacing", "host_a_b_c.json"))
        with pacing._locked(p) as f:
            self.assertEqual(f.read(), "")

    def test_jittered(self):
        # Bounds of the jitter.
        self.assertEqual(pacing.jittered(10, 0.5, rnd=lambda: 0.0), 10)
        self.assertEqual(pacing.jittered(10, 0.5, rnd=lambda: 1.0), 15)
        self.assertTrue(all(10 <= pacing.jittered(10, 0.5) <= 15 for _ in range(50)))

    def test_reserve_gap_cap_and_corrupt_file(self):
        # First slot is now; the next one waits a full gap; a later caller after the gap waits nothing.
        self.assertEqual(pacing.reserve("k", 10, now=1000), 0)
        self.assertEqual(pacing.reserve("k", 10, now=1003), 7)
        self.assertEqual(pacing.reserve("k", 10, now=1100), 0)
        # A wait beyond the cap is cut to the cap.
        with mock.patch.object(config, "PACE_WAIT_MAX", 5):
            pacing.reserve("c", 100, now=0)
            self.assertEqual(pacing.reserve("c", 100, now=1), 5)
        # A corrupt slot file is treated as empty.
        pacing._slot_file("bad").write_text("{not json", encoding="utf-8")
        self.assertEqual(pacing.reserve("bad", 10, now=5), 0)

    def test_plan_order(self):
        # Engine, host, then the browser-wide key.
        keys = [k for k, _ in pacing._plan("https://www.google.com/search?q=x", "google")]
        self.assertEqual(keys, ["engine:google", "host:google.com", "nav"])
        # A loopback page only respects the browser-wide gap.
        self.assertEqual([k for k, _ in pacing._plan("http://127.0.0.1/x")], ["nav"])

    def test_wait_for_chains_the_keys(self):
        # Fixed gaps: engine 50, host 10, nav 2.
        with mock.patch.object(pacing, "jittered", side_effect=lambda base, spread, rnd=None: base), \
                mock.patch.multiple(config, SEARCH_GAP=50, HOST_GAP=10, NAV_GAP=2, PACE_WAIT_MAX=1000):
            # First query: no wait.
            self.assertEqual(pacing._wait_for("https://google.com/s", "google", now=0), 0)
            # A second query 5s later waits for the engine gap; host and nav slots line up behind it.
            self.assertEqual(pacing._wait_for("https://google.com/s", "google", now=5), 45)
            # A plain page on the same host right after waits for the host gap after that slot.
            self.assertEqual(pacing._wait_for("https://google.com/p", "", now=6), 54)

    def test_before_navigation_and_request(self):
        # The async wait sleeps for the reserved time; the blocking one too; loopback requests return at once.
        slept = []

        async def fake_sleep(s):
            slept.append(s)

        with mock.patch.object(pacing, "_wait_for", return_value=3.0), mock.patch.object(asyncio, "sleep", fake_sleep):
            self.assertEqual(asyncio.run(pacing.before_navigation("https://example.com/")), 3.0)
        self.assertEqual(slept, [3.0])
        with mock.patch.object(pacing, "reserve", return_value=2.0), mock.patch.object(pacing.time, "sleep") as sl:
            self.assertEqual(pacing.before_request("https://example.com/f.pdf"), 2.0)
        sl.assert_called_once_with(2.0)
        self.assertEqual(pacing.before_request("http://127.0.0.1:1/x"), 0.0)

    def test_cross_process_slots_are_one_gap_apart(self):
        # Three processes reserve the same key at the same moment.
        code = ("import sys,json;sys.path.insert(0,sys.argv[1]);from pathlib import Path;"
                "from search_fetch import config,pacing;config.HOME=Path(sys.argv[2]);"
                "print(json.dumps(pacing.reserve('host:example.com', 30, now=1000.0)))")
        procs = [subprocess.Popen([sys.executable, "-c", code, str(_SRC), str(self.home)],
                                  stdout=subprocess.PIPE, text=True) for _ in range(3)]
        waits = sorted(json.loads(p.communicate(timeout=30)[0]) for p in procs)
        # One goes now, the next after one gap, the last after two.
        self.assertEqual(waits, [0, 30, 60])


if __name__ == "__main__":
    # Verbose run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nPACING:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
