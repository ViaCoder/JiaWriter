#!/usr/bin/env python3
"""Unit tests for tests/eval/run_eval.py (stdlib only, no network, no browser).
Run: python3 -m unittest tests/eval/test_run_eval.py"""
# Output capture for main().
import contextlib

# JSON fixtures.
import io
import json

# Process id and environment.
import os

# Scratch directories.
import shutil
import sys
import tempfile

# Test framework.
import unittest

# Patching run_sf.
from pathlib import Path
from unittest import mock

# Import the module under test from this directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_eval  # noqa: E402

# Scratch space inside the repository's tests/tmp.
TMP_ROOT = Path(__file__).resolve().parents[1] / "tmp"


class EvalTest(unittest.TestCase):
    def setUp(self):
        # Fresh scratch directory per test.
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(prefix="eval-", dir=str(TMP_ROOT)))

    def tearDown(self):
        # Remove it.
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_load_set(self):
        # Both shipped sets load, with unique ids.
        q = run_eval.load_set(run_eval.HERE / "queries.json")
        u = run_eval.load_set(run_eval.HERE / "urls.json")
        self.assertEqual((len(q), len(u)), (20, 30))
        self.assertEqual(len({x["id"] for x in q + u}), 50)

    def test_fresh_markers(self):
        # English and Chinese markers within a day; older dates do not count.
        text = "3 hours ago · 45 mins ago · 2 小时前 · 刚刚 · 1 day ago · 3 days ago · 2024-01-01"
        self.assertEqual(run_eval.fresh_markers(text), 5)
        self.assertEqual(run_eval.fresh_markers(None), 0)

    def test_noise_markers(self):
        # Login, cookie and ICP lines are boilerplate.
        self.assertEqual(run_eval.noise_markers("登录 | 注册\nAccept all cookies\n京ICP备123号\n正文"), 5)

    def test_prose_ratio(self):
        # One long prose line, one link line, one short line.
        prose = "这是一段足够长的正文内容，用来说明页面里真正的文字部分占了多少比例，长度超过四十个字。"
        text = f"{prose}\n* [导航链接很长很长很长很长很长很长很长很长很长很长很长很长很长](https://example.com)\n短行"
        self.assertAlmostEqual(run_eval.prose_ratio(text), len(prose) / sum(len(x) for x in text.splitlines()), 3)
        self.assertEqual(run_eval.prose_ratio(""), 0.0)

    def test_stage_counts(self):
        # Two engines, one broken line, one record without a stage.
        ops = self.tmp / "s.ops.jsonl"
        ops.write_text('{"engine":"google","stage":"challenged"}\nnot json\n{"engine":"bing","stage":"ok"}\n'
                       '{"engine":"bing","stage":"ok"}\n{"engine":"bing"}\n', encoding="utf-8")
        self.assertEqual(run_eval.stage_counts(ops), {"google": {"challenged": 1}, "bing": {"ok": 2}})
        self.assertEqual(run_eval.stage_counts(self.tmp / "none"), {})

    def test_process_memory(self):
        # This process has memory; a dead pid has none and no children.
        self.assertGreater(run_eval._rss_kb(os.getpid()), 0)
        self.assertEqual((run_eval._rss_kb(2**22 + 7), run_eval._children(2**22 + 7)), (0, []))
        self.assertGreater(run_eval.tree_rss_mb(os.getpid(), ""), 0)

    def test_run_sf_real_and_timeout(self):
        # A real run of sf.py --help with this interpreter.
        env = {**os.environ, "SEARCH_FETCH_HOME": str(self.tmp / "home")}
        run = run_eval.run_sf(sys.executable, ["--help"], self.tmp, env, "", 60)
        self.assertEqual(run["exit"], 0)
        self.assertIn("search", run["stdout"])
        # A run that exceeds its bound is killed and reported as a timeout.
        with mock.patch.object(run_eval, "SF_PY", self.tmp / "sf.py"):
            (self.tmp / "sf.py").write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
            slow = run_eval.run_sf(sys.executable, [], self.tmp, env, "", 1)
        self.assertEqual(slow["exit"], "timeout")

    def test_newest_ops(self):
        # Only files written after the start time count.
        res = self.tmp / ".search_fetchres"
        res.mkdir()
        (res / "search-a.ops.jsonl").write_text("{}", encoding="utf-8")
        self.assertEqual(run_eval._newest_ops(self.tmp, 0).name, "search-a.ops.jsonl")
        self.assertIsNone(run_eval._newest_ops(self.tmp, 2**40))

    def _fake_run(self, stdout="", stderr="", code=0):
        # Canned run result.
        return {"exit": code, "seconds": 1.0, "peak_mb": 10.0, "stdout": stdout, "stderr": stderr}

    def test_search_row(self):
        # Two blocks from two engines, one fresh marker.
        out = json.dumps({"blocks": [{"engine": "google", "results": [{"u": "a"}, {"u": "b"}], "markdown": "2 hours ago"},
                                     {"engine": "bing", "results": [], "markdown": ""}]})
        with mock.patch.object(run_eval, "run_sf", return_value=self._fake_run(out)) as m:
            row = run_eval.search_row({"id": "q", "group": "g", "query": "x", "fresh": "day"},
                                      "py", self.tmp, {}, "")
        self.assertIn("--fresh", m.call_args.args[1])
        self.assertEqual((row["results"], row["engines_with_results"], row["fresh_markers"]), (2, 1, 1))
        # Broken output and a missing driver model.
        with mock.patch.object(run_eval, "run_sf", return_value=self._fake_run("oops", "missing local-LLM config")):
            row = run_eval.search_row({"id": "q", "group": "g", "query": "x"}, "py", self.tmp, {}, "")
        self.assertEqual((row["results"], row["fresh_markers"], row["llm_missing"]), (0, None, True))

    def test_fetch_row_status(self):
        # Each failure class.
        long_md = json.dumps({"markdown": "正文" * 400})
        cases = [(self._fake_run(long_md), "ok"), (self._fake_run(json.dumps({"markdown": "短"})), "thin"),
                 (self._fake_run("", "blocked: x", 1), "blocked"), (self._fake_run("", "boom", 2), "error"),
                 (self._fake_run("", "", "timeout"), "timeout")]
        for run, want in cases:
            with mock.patch.object(run_eval, "run_sf", return_value=run):
                row = run_eval.fetch_row({"id": "u", "group": "g", "url": "https://example.com"}, "py", self.tmp, {}, "")
            self.assertEqual(row["status"], want)

    def test_summarize(self):
        # One search with results, one without; one good fetch, one blocked document.
        rows = [
            {"kind": "search", "results": 4, "stages": {"g": {"ok": 1}}, "fresh_markers": 2, "llm_missing": False,
             "seconds": 2, "peak_mb": 50},
            {"kind": "search", "results": 0, "stages": {"g": {"challenged": 1}}, "fresh_markers": None,
             "llm_missing": True, "seconds": 4, "peak_mb": 60},
            {"kind": "fetch", "doc": False, "status": "ok", "prose_ratio": 0.5, "noise": 3, "seconds": 3, "peak_mb": 70},
            {"kind": "fetch", "doc": True, "status": "blocked", "prose_ratio": 0, "noise": 0, "seconds": 5, "peak_mb": 40},
        ]
        s = run_eval.summarize(rows)
        self.assertEqual((s["search_with_results"], s["search_results_avg"], s["search_llm_missing"]), (0.5, 2.0, 1))
        self.assertEqual(s["search_stages"], {"ok": 1, "challenged": 1})
        self.assertEqual((s["fetch_ok"], s["doc_ok"], s["fetch_status"]), (0.5, 0.0, {"blocked": 1, "ok": 1}))
        self.assertEqual((s["prose_ratio_avg"], s["noise_avg"], s["peak_mb"]), (0.5, 3.0, 70))
        self.assertIsNone(run_eval.summarize([])["fetch_ok"])

    def test_main_writes_rows_and_summary(self):
        # Every run returns an empty search result; only the search half is run.
        with mock.patch.object(run_eval, "run_sf", return_value=self._fake_run('{"blocks": []}')), \
                contextlib.redirect_stdout(io.StringIO()):
            with mock.patch.object(run_eval.time, "sleep") as pause:
                code = run_eval.main(["--label", "t", "--only", "search", "--out", str(self.tmp), "--python", "py",
                                      "--sf", str(self.tmp / "other" / "sf.py"), "--search-pause", "7"])
        self.assertEqual(code, 0)
        # 19 pauses of 7s between the 20 searches.
        self.assertEqual((pause.call_count, pause.call_args.args), (19, (7.0,)))
        # --sf selects the checkout under test.
        self.assertEqual(run_eval.SF_PY, (self.tmp / "other" / "sf.py").resolve())
        run_eval.SF_PY = run_eval.REPO / "sf.py"
        rows = json.loads((self.tmp / "t" / "rows.json").read_text(encoding="utf-8"))
        self.assertEqual((len(rows), rows[0]["kind"]), (20, "search"))
        self.assertTrue((self.tmp / "t" / "summary.json").is_file())


if __name__ == "__main__":
    # Run the tests.
    unittest.main()
