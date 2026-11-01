#!/usr/bin/env python3
"""unittest entry for the check-style suites, so `python3 -m unittest discover tests` runs
EVERY offline test. Each script runs in its own process under tests/netguard.py (outbound
network refused) and must exit 0; the unittest-style modules are discovered directly.
Run: python3 -m unittest discover -s tests   (with the venv python for the venv suites)
"""
# Child processes.
import subprocess

# The current interpreter.
import sys

# Test framework.
import unittest

# Paths.
from pathlib import Path

# This directory.
HERE = Path(__file__).resolve().parent
# Check-style scripts (each prints PASS/FAIL and sets its exit code).
SCRIPTS = ["test_pure.py", "test_kb.py", "test_docparse.py", "test_media_tasks.py", "test_ingest.py",
           "test_url_guard.py", "test_known_urls.py", "test_units.py"]


class CheckStyleSuites(unittest.TestCase):
    def test_check_style_suites_pass_offline(self):
        # One subtest per script, so a failure names the suite.
        for name in SCRIPTS:
            with self.subTest(suite=name):
                # Run it under the network guard; capture its output for the failure message.
                r = subprocess.run([sys.executable, str(HERE / "netguard.py"), str(HERE / name)],
                                   capture_output=True, text=True, timeout=600)
                # Exit 0 and no outbound attempt.
                self.assertEqual(r.returncode, 0, f"{name} failed:\n{(r.stdout + r.stderr)[-2000:]}")
                self.assertNotIn("NETGUARD", r.stderr, f"{name} tried to reach the network")

    def test_function_map_is_complete(self):
        # Every function of the engine has a direct test.
        r = subprocess.run([sys.executable, str(HERE / "function_map.py")], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-1500:])


if __name__ == "__main__":
    # Run directly.
    unittest.main()
