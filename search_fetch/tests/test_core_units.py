#!/usr/bin/env python3
"""Direct unit tests for the helpers of artifacts, __main__, config, ingest, known_urls,
tasks, fetch and cli — stdlib + mocks only: no browser, no network, no driver model.
Scratch HOME and working folder under tests/tmp. Run: python3 tests/test_core_units.py
"""
# Async helpers under test.
import asyncio

# stdout/stderr capture.
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import __main__ as entry  # noqa: E402
from search_fetch import artifacts, cli, config, fetch, ingest, known_urls, tasks  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


class Scratch(unittest.TestCase):
    """Each test runs in a fresh working folder with its own HOME."""

    def setUp(self):
        # Fresh directories.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(prefix="core-", dir=str(_TMP_ROOT)))
        # Work in it.
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        # HOME and run dir patched.
        self.patches = [mock.patch.object(config, "HOME", self.tmp / "home"),
                        mock.patch.object(config, "RUN_DIR", None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        # Undo everything.
        for p in self.patches:
            p.stop()
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)


class ArtifactsTest(Scratch):
    def test_write_atomic_text_bytes_and_cleanup(self):
        # Text and bytes land; a failing write leaves no temp file.
        p = self.tmp / "a.txt"
        artifacts._write_atomic(p, "中文")
        artifacts._write_atomic(self.tmp / "b.bin", b"\x00\x01")
        self.assertEqual((p.read_text(encoding="utf-8"), (self.tmp / "b.bin").read_bytes()), ("中文", b"\x00\x01"))
        with self.assertRaises(TypeError):
            artifacts._write_atomic(self.tmp / "c.txt", 42)
        self.assertEqual(sorted(x.name for x in self.tmp.iterdir() if x.name.endswith(".tmp")), [])

    def test_save_binary(self):
        # Saved under the URL's slug; an unwritable directory returns None.
        p = artifacts._save_binary("https://example.com/r.pdf", ".pdf", b"%PDF")
        self.assertEqual((p.suffix, p.read_bytes()), (".pdf", b"%PDF"))
        with mock.patch.object(artifacts, "_write_atomic", side_effect=OSError("disk full")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(artifacts._save_binary("https://example.com/x", ".pdf", b"x"))

    def test_page_header(self):
        # Source, final URL, meta and description.
        h = artifacts._page_header("https://a.example/", "https://b.example/", {"title": "T", "lang": "zh", "desc": "D"})
        self.assertEqual(h, "<!-- source: https://a.example/ -->\n<!-- final_url: https://b.example/ -->\n"
                            "<!-- meta: title=T; lang=zh -->\n\n> D\n\n")

    def test_blocks_json(self):
        # The machine contract with defaults for missing fields.
        out = json.loads(artifacts._blocks_json("q", [{"engine": "google", "results": [{"u": "x", "t": "y"}]}]))
        self.assertEqual(out, {"query": "q", "blocks": [{"engine": "google", "page": 0, "url": "",
                                                         "results": [{"u": "x", "t": "y"}], "markdown": ""}]})


class EntryAndConfigTest(Scratch):
    def test_env_file_follows_home(self):
        # Sibling of SEARCH_FETCH_HOME, else the repo root.
        with mock.patch.dict(os.environ, {"SEARCH_FETCH_HOME": str(self.tmp / "h")}):
            self.assertEqual(entry._env_file(), self.tmp / "rag.env")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(entry._env_file().name, "rag.env")

    def test_load_env_fills_gaps_only(self):
        # rag.env values fill unset names; the real environment wins.
        (self.tmp / "rag.env").write_text("SF_URL=http://file/v1\nSF_MODEL=m-file\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"SEARCH_FETCH_HOME": str(self.tmp / "h"), "SF_MODEL": "m-env"}):
            entry._load_env()
            self.assertEqual((os.environ["SF_URL"], os.environ["SF_MODEL"]), ("http://file/v1", "m-env"))

    def test_config_log(self):
        # One prefixed line on stderr.
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            config._log("hi")
        self.assertEqual(err.getvalue(), "[search_fetch] hi\n")


class IngestTest(Scratch):
    def test_inside(self):
        # Root itself and its children are inside; siblings are not.
        root = Path("/r/a")
        self.assertTrue(ingest._inside(root, root) and ingest._inside(root / "x/y", root))
        self.assertFalse(ingest._inside(Path("/r/ab"), root))

    def test_walk_materials_skips_hidden_and_escaping_links(self):
        # A visible file, a hidden one, a link out of the folder.
        root = self.tmp / "参考资料"
        (root / "sub").mkdir(parents=True)
        (root / "sub" / "a.md").write_text("x", encoding="utf-8")
        (root / ".hidden").write_text("x", encoding="utf-8")
        (self.tmp / "secret.txt").write_text("s", encoding="utf-8")
        (root / "out.txt").symlink_to(self.tmp / "secret.txt")
        got = [(rel.as_posix(), real is not None) for rel, real in ingest._walk_materials(root)]
        self.assertEqual(got, [("out.txt", False), ("sub/a.md", True)])

    def test_skip_records_and_logs(self):
        # Record with the extension as the kind, one log line.
        files, err = [], io.StringIO()
        with contextlib.redirect_stderr(err):
            ingest._skip(files, Path("a/b.XYZ"), "unsupported", "unsupported file type, skipped")
        self.assertEqual(files, [{"file": "a/b.XYZ", "kind": ".xyz", "status": "unsupported", "chars": 0}])
        self.assertIn("a/b.XYZ", err.getvalue())


class KnownUrlsTest(Scratch):
    def test_enabled(self):
        # Truth values of the switch.
        for v, want in (("1", True), ("on", True), ("0", False), ("", False)):
            with mock.patch.dict(os.environ, {"SEARCH_FETCH_ONLY_KNOWN_URLS": v}):
                self.assertEqual(known_urls.enabled(), want, v)

    def test_ledger_path(self):
        # Run directory when there is one, else the results folder.
        self.assertEqual(known_urls.ledger_path(), self.tmp / ".search_fetchres" / "known-urls.txt")
        with mock.patch.object(config, "RUN_DIR", self.tmp / "run"):
            self.assertEqual(known_urls.ledger_path(), self.tmp / "run" / "known-urls.txt")

    def test_fragment_forms_and_keys(self):
        # Fragment, unwrapped redirect forms, and the exact fragment key.
        self.assertEqual((known_urls._fragment("https://a.example/p#s"), known_urls._fragment("http://[x")), ("s", ""))
        forms = known_urls._forms("https://www.google.com/url?q=https://t.example/a")
        self.assertIn("https://t.example/a", forms)
        self.assertIn("https://a.example/p#s", known_urls._ledger_keys("https://a.example/p#s"))


class TasksTest(Scratch):
    def test_now_and_created(self):
        # UTC ISO now; malformed creation times are 0.
        self.assertTrue(tasks._now_iso().endswith("+00:00"))
        self.assertEqual((tasks._created_ts({"created": "nope"}), tasks._created_ts({"created": None})), (0.0, 0.0))

    def test_write_record_and_load(self):
        # A written record loads back; broken files load as {}.
        p = self.tmp / "t.json"
        tasks._write_record(p, {"id": "x"})
        (self.tmp / "bad.json").write_text("{", encoding="utf-8")
        self.assertEqual((tasks._load(p), tasks._load(self.tmp / "bad.json"), tasks._load(self.tmp / "none")),
                         ({"id": "x"}, {}, {}))

    def test_cutoff(self):
        # Naive values are UTC; empty or bad values disable the filter.
        self.assertEqual(tasks._cutoff("1970-01-01T00:01:00"), 60.0)
        self.assertEqual((tasks._cutoff(""), tasks._cutoff("garbage")), (0.0, 0.0))

    def test_run_task_kinds(self):
        # OCR of an image, ASR, and an unknown kind.
        img = self.tmp / "p.png"
        img.write_bytes(b"png")
        with mock.patch("search_fetch.docparse._ocr_image_bytes", return_value="文字") as ocr:
            self.assertEqual(tasks._run_task({"kind": "ocr", "payload": {"bin": str(img), "kind": "image"}}), "文字")
        ocr.assert_called_once_with(b"png", ".png")
        with mock.patch("search_fetch.docparse._ocr_image_bytes", return_value=""), self.assertRaises(RuntimeError):
            tasks._run_task({"kind": "ocr", "payload": {"bin": str(img), "kind": "image"}})
        with mock.patch("search_fetch.media.transcribe", return_value="转写"):
            self.assertEqual(tasks._run_task({"kind": "asr", "payload": {}}), "转写")
        with self.assertRaises(RuntimeError):
            tasks._run_task({"kind": "zzz"})

    def test_run_worker_done_failed_and_cleared(self):
        # A finished task writes its output and a done record.
        rec = tasks._tasks_dir() / "asr-1.json"
        tasks._write_record(rec, {"id": "asr-1", "kind": "asr", "payload": {"source": "s", "title": "t"},
                                  "status": "pending", "created": tasks._now_iso()})
        with mock.patch.object(tasks, "_run_task", return_value="文本"), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(tasks.run_worker(str(rec)), 0)
        self.assertEqual(tasks._load(rec)["status"], "done")
        self.assertEqual((rec.parent / "asr-1.out.md").read_text(encoding="utf-8"), "文本")
        # A failing task writes a failed record.
        with mock.patch.object(tasks, "_run_task", side_effect=RuntimeError("boom")), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(tasks.run_worker(str(rec)), 1)
        self.assertEqual(tasks._load(rec)["error"], "boom")
        # A record cleared while running is not resurrected.
        def clear_then_return(_rec):
            rec.unlink()
            return "late"
        tasks._write_record(rec, {"id": "asr-1", "kind": "asr", "payload": {}, "status": "pending", "created": ""})
        with mock.patch.object(tasks, "_run_task", side_effect=clear_then_return), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(tasks.run_worker(str(rec)), 1)
        self.assertFalse(rec.exists())
        # An unreadable record exits 1.
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(tasks.run_worker(str(self.tmp / "missing.json")), 1)


class FetchHelpersTest(Scratch):
    DOC = {"final_url": "https://example.com/r.pdf", "text": "正文" * 10,
           "meta": {"kind": "pdf", "chars": 20}, "data": b"%PDF-1.4"}

    def test_doc_suffix_and_enqueue(self):
        # Suffix from the kind; the OCR task carries the binary path.
        self.assertEqual(fetch._doc_suffix(self.DOC, "u"), ".pdf")
        with mock.patch.object(tasks, "enqueue", return_value="ocr-1") as enq:
            self.assertEqual(fetch._enqueue_ocr(self.DOC, "u", Path("/b.pdf")), "ocr-1")
        self.assertEqual(enq.call_args.args[1]["bin"], "/b.pdf")

    def test_still_blocked(self):
        # Content after all; an iframe wall is captcha; a phrase-only short page counts as content (no model).
        page = object()
        cases = [({"text": "ok"}, False, ""), ({"challengeIframe": True}, True, "captcha"), ({}, True, "")]
        for obs, challenged, want in cases:
            with mock.patch("search_fetch.browser._observe", mock.AsyncMock(return_value=obs)), \
                    mock.patch("search_fetch.browser._looks_challenged", return_value=challenged):
                self.assertEqual(asyncio.run(fetch._still_blocked(page, "u")), want)

    def test_emit_and_emit_page(self):
        # Raw text, JSON contract and markdown-only output.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fetch._emit("a")
            fetch._emit_page({"final_url": "f", "markdown": "m", "task": "x"}, True)
            fetch._emit_page({"final_url": "f", "markdown": "m"}, False)
        self.assertEqual(out.getvalue(), 'a{"final_url": "f", "markdown": "m"}m')

    def test_finish_doc_text_and_deferred(self):
        # Parsed text is saved with its original; deferred OCR returns a receipt.
        with contextlib.redirect_stderr(io.StringIO()):
            res = fetch._finish_doc("https://example.com/r.pdf", dict(self.DOC))
        self.assertEqual(res["markdown"], "正文" * 10)
        self.assertTrue(any(p.suffix == ".pdf" for p in (self.tmp / ".search_fetchres").iterdir()))
        with mock.patch.object(tasks, "enqueue", return_value="ocr-9"), contextlib.redirect_stderr(io.StringIO()):
            res = fetch._finish_doc("https://example.com/s.pdf", dict(self.DOC, needs_task=True))
        self.assertEqual(res["task"], "ocr-9")
        # Deferred OCR without bytes is an error, not an empty OCR job.
        with self.assertRaises(RuntimeError), contextlib.redirect_stderr(io.StringIO()):
            fetch._finish_doc("https://example.com/t.pdf", dict(self.DOC, needs_task=True, data=b""))

    def test_page_markdown(self):
        # BM25 with a query, pruning without one or when BM25 fails.
        with mock.patch("search_fetch.filters.bm25_fit", return_value={"fit": "q"}), \
                mock.patch("search_fetch.markdown._html_to_markdown", return_value={"fit": "p"}):
            self.assertEqual(fetch._page_markdown("<p>", "u", "x")["fit"], "q")
            self.assertEqual(fetch._page_markdown("<p>", "u", None)["fit"], "p")
        with mock.patch("search_fetch.filters.bm25_fit", side_effect=ImportError("no")), \
                mock.patch("search_fetch.markdown._html_to_markdown", return_value={"fit": "p"}), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(fetch._page_markdown("<p>", "u", "x")["fit"], "p")

    def test_page_body(self):
        # Date line first; a collapsed de-noised page falls back to raw.
        body = fetch._page_body({"fit": "f" * 300, "raw": "r", "matched": True}, {"pub": "2026-10-31T08:00"})
        self.assertTrue(body.startswith("（发布时间：2026-10-31）\n\nfff"))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(fetch._page_body({"fit": "x", "raw": "raw text"}, {}), "raw text")


class CliHelpersTest(Scratch):
    def test_engines(self):
        # Normalized names; unknown ones exit.
        self.assertEqual(cli._engines(" Google , startpage,"), ["google", "startpage"])
        with self.assertRaises(SystemExit):
            cli._engines("google,nope")

    def test_selftest_row(self):
        # Verdict from the result counts.
        self.assertEqual(cli._selftest_row(6, 0, "bing"),
                         {"engine": "bing", "ok": True, "p1_results": 6, "p2_results": 0, "paginated": False})
        self.assertFalse(cli._selftest_row(4, 9, "bing")["ok"])

    def test_guarded(self):
        # Errors become rc 1 with a log line; SystemExit passes through.
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(cli._guarded(lambda: 1 / 0), 1)
        self.assertIn("failed: division by zero", err.getvalue())
        with self.assertRaises(SystemExit):
            cli._guarded(lambda: sys.exit(3))

    def test_parser(self):
        # Every subcommand parses.
        ap = cli._parser()
        self.assertEqual(ap.parse_args(["search", "q", "--fresh", "day"]).fresh, "day")
        self.assertTrue(ap.parse_args(["fetch", "u", "--sync"]).sync)
        self.assertEqual(ap.parse_args(["tasks", "wait", "--timeout", "3"]).timeout, 3.0)

    def test_cmd_search_saves_and_registers(self):
        # Mocked browser and search: the result links reach the ledger and stdout.
        blocks = [{"engine": "google", "page": 1, "url": "s", "results": [{"u": "https://r.example/a", "t": "t"}], "markdown": "m"}]
        a = SimpleNamespace(engine="google", query="q", pages=1, lang=None, region=None, fresh=None, json=True)
        with mock.patch("search_fetch.browser._connect", mock.AsyncMock(return_value=object())), \
                mock.patch("search_fetch.search.search", mock.AsyncMock(return_value=(blocks, None))), \
                mock.patch("search_fetch.known_urls.register") as reg, \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli._cmd_search(a), 0)
        self.assertEqual(list(reg.call_args.args[0]), ["https://r.example/a"])
        self.assertEqual(json.loads(out.getvalue())["blocks"][0]["results"][0]["u"], "https://r.example/a")

    def test_cmd_fetch_and_ingest(self):
        # Fetch defers OCR unless --sync; ingest returns its exit code.
        with mock.patch("search_fetch.fetch.run_fetch", mock.AsyncMock()) as rf:
            self.assertEqual(cli._cmd_fetch(SimpleNamespace(url="u", query=None, json=False, sync=True)), 0)
        self.assertFalse(rf.call_args.kwargs["defer"])
        with mock.patch("search_fetch.ingest.run", return_value=2):
            self.assertEqual(cli._cmd_ingest(SimpleNamespace(dir="d", json=False)), 2)

    def test_cmd_selftest_exit_codes(self):
        # Enough results passes; too few exits 2; a crashing engine is a FAIL row.
        good = [{"page": 1, "results": [1] * 6}, {"page": 2, "results": [1]}]
        for found, want in ((good, 0), ([{"page": 1, "results": [1]}], 2), (RuntimeError("x"), 2)):
            search = mock.AsyncMock(side_effect=found) if isinstance(found, Exception) else mock.AsyncMock(return_value=(found, None))
            with mock.patch("search_fetch.browser._connect", mock.AsyncMock(return_value=object())), \
                    mock.patch("search_fetch.search.search", search), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli._cmd_selftest(SimpleNamespace(engine="bing", json=False)), want)

    def test_cmd_tasks_ops(self):
        # wait, list and clear.
        with mock.patch.object(tasks, "wait_all", return_value={"done": [1], "failed": [], "pending": []}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            cli._cmd_tasks(SimpleNamespace(op="wait", timeout=1, since=None, json=False))
        self.assertEqual(out.getvalue(), "done=1 failed=0 pending=0\n")
        with mock.patch.object(tasks, "snapshot", return_value=[{"id": "a", "status": "done", "payload": {"source": "s"}}]), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            cli._cmd_tasks(SimpleNamespace(op="list", since=None, json=False))
        self.assertIn("a  done", out.getvalue())
        with mock.patch.object(tasks, "clear", return_value=3), contextlib.redirect_stdout(io.StringIO()) as out:
            cli._cmd_tasks(SimpleNamespace(op="clear"))
        self.assertEqual(out.getvalue(), "cleared 3 file(s)\n")

    def test_cmd_browser_status_and_stop(self):
        # status reports the bridge; stop reports the closed tabs and always exits 0.
        with mock.patch("search_fetch.bridge.status", return_value={"connected": False, "error": "x"}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli._cmd_browser(SimpleNamespace(op="status", json=True)), 0)
        self.assertFalse(json.loads(out.getvalue())["connected"])
        with mock.patch("search_fetch.browser.stop_browser", return_value={"closed": 2, "connected": True}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli._cmd_browser(SimpleNamespace(op="stop", json=False)), 0)
        self.assertEqual(out.getvalue(), "closed 2 tab(s)\n")

    def test_cmd_bridge_install_and_status(self):
        # install prints the steps; status exits 1 while Chrome is not connected.
        rep = {"extension_dir": "/h/extension", "extension_id": "abc", "launcher": "/h/bridge/host.sh", "manifests": ["/m.json"]}
        with mock.patch("search_fetch.bridge.install", return_value=rep), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli._cmd_bridge(SimpleNamespace(op="install", json=False)), 0)
        self.assertIn("Load unpacked", out.getvalue())
        self.assertIn("/h/extension", out.getvalue())
        with mock.patch("search_fetch.bridge.status", return_value={"connected": False}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli._cmd_bridge(SimpleNamespace(op="status", json=False)), 1)

if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nCORE UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
