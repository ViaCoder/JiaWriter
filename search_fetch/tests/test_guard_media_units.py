#!/usr/bin/env python3
"""Direct unit tests for the url_guard helpers and the media download/ASR helpers.
stdlib + mocks only; the connection-pinning test talks to a throwaway 127.0.0.1 server.
Run: python3 tests/test_guard_media_units.py
"""
# Output capture.
import contextlib
import http.server
import io
import os
import shutil
import sys
import tempfile
import threading
import types
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import config, media, url_guard  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


class GuardHelpersTest(unittest.TestCase):
    def test_allow_private(self):
        # Truth values of the opt-in.
        for v, want in (("1", True), ("yes", True), ("0", False), ("", False)):
            with mock.patch.dict(os.environ, {"SEARCH_FETCH_ALLOW_PRIVATE": v}):
                self.assertEqual(url_guard.allow_private(), want, v)

    def test_ends_in_number(self):
        # WHATWG: a last label that is a number makes the host an IPv4 address.
        self.assertTrue(url_guard._ends_in_number("1.2.3.4") and url_guard._ends_in_number("a.0x7f."))
        self.assertFalse(url_guard._ends_in_number("example.com"))

    def test_whatwg_ipv4(self):
        # Hex, octal, short and decimal forms; invalid ones are None.
        self.assertEqual(url_guard._whatwg_ipv4("0x7f.1"), "127.0.0.1")
        self.assertEqual(url_guard._whatwg_ipv4("2130706433"), "127.0.0.1")
        self.assertEqual(url_guard._whatwg_ipv4("0x"), "0.0.0.0")
        self.assertEqual(url_guard._whatwg_ipv4("010.0.0.1"), "8.0.0.1")
        for bad in ("1.2.3.4.5", "256.1.1.1", "09.1.1.1", "1.2.3.256x"):
            self.assertIsNone(url_guard._whatwg_ipv4(bad), bad)

    def test_canonical_hosts(self):
        # Case, trailing dot, percent-encoding, IPv6 and numeric IPv4 are normalised.
        self.assertEqual(url_guard._canonical_hosts("Example.COM."), ["example.com"])
        self.assertEqual(url_guard._canonical_hosts("%31%32%37.0.0.1"), ["127.0.0.1"])
        self.assertEqual(url_guard._canonical_hosts("[0:0::1]"), ["::1"])
        self.assertIn("xn--fiqs8s", url_guard._canonical_hosts("中国"))
        for bad in ("a b", "%zz%ff", "1.2.3.999"):
            with self.assertRaises(url_guard.BlockedURL, msg=bad):
                url_guard._canonical_hosts(bad)

    def test_browser_host(self):
        # Backslash and @ are read the browser way.
        self.assertEqual(url_guard._browser_host("http://127.0.0.1\\@example.org/"), "127.0.0.1")
        self.assertEqual(url_guard._browser_host("https://user@a.example:8443/x"), "a.example")
        self.assertEqual(url_guard._browser_host("http://[::1]:80/"), "[::1]")

    def test_proxy_hosts(self):
        # Proxy host names from the environment.
        with mock.patch.object(urllib.request, "getproxies",
                               return_value={"http": "http://Proxy.LAN:3128", "https": "10.0.0.2:8080", "x": "http://[bad"}):
            self.assertEqual(url_guard._proxy_hosts(), {"proxy.lan", "10.0.0.2"})

    def test_pinned_http_open_connects_to_the_pinned_address(self):
        # A local server; the request names a host that does not resolve, pinned to 127.0.0.1.
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                # Echo the Host header.
                self.send_response(200)
                self.end_headers()
                self.wfile.write(self.headers["Host"].encode())

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            port = srv.server_address[1]
            req = urllib.request.Request(f"http://pin.invalid:{port}/")
            req._sf_pin, req._sf_pin_hostport, req.timeout = "127.0.0.1", req.host, 5
            body = url_guard._PinnedHTTPHandler().http_open(req).read().decode()
        finally:
            srv.shutdown()
        # Connected to the pin, while the Host header kept the real name.
        self.assertEqual(body, f"pin.invalid:{port}")

    def test_pinned_https_open_uses_https_connection(self):
        # do_open receives a factory for HTTPS connections and the handler's TLS context.
        h = url_guard._PinnedHTTPSHandler(context="ctx")
        with mock.patch.object(h, "do_open", return_value="resp") as do_open:
            self.assertEqual(h.https_open(urllib.request.Request("https://a.example/")), "resp")
        self.assertEqual(do_open.call_args.kwargs["context"], "ctx")


class MediaHelpersTest(unittest.TestCase):
    def setUp(self):
        # Scratch HOME.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="media-", dir=str(_TMP_ROOT)))
        self.patch = mock.patch.object(config, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        # Restore.
        self.patch.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_ytdl_runs_under_the_guard_with_home_cache(self):
        # A fake yt_dlp module records the options it was built with.
        seen = {}

        class FakeYDL:
            def __init__(self, opts):
                seen.update(opts)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch.dict(sys.modules, {"yt_dlp": types.SimpleNamespace(YoutubeDL=FakeYDL)}), \
                mock.patch.object(url_guard, "guard_resolution", return_value=contextlib.nullcontext()) as guard:
            with media._ytdl({"skip_download": True}) as y:
                self.assertIsInstance(y, FakeYDL)
        guard.assert_called_once()
        self.assertEqual((seen["cachedir"], seen["skip_download"], seen["quiet"]),
                         (str(self.home / "yt-dlp-cache"), True, True))

    def test_meta_block(self):
        # Duration in minutes and seconds, live marker, views and description.
        md = media._meta_block({"title": "T", "duration": 125, "is_live": True, "view_count": 9, "description": "简介"}, "u")
        self.assertIn("- 时长: 2分5秒（直播）", md)
        self.assertIn("- 播放量: 9", md)
        self.assertTrue(md.endswith("## 简介\n简介"))
        self.assertIn("- 时长: 未知", media._meta_block({}, "u"))

    def test_asr_file_retries_then_succeeds_or_fails(self):
        # The fake Space fails once, then returns (language, text).
        calls = []

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            def predict(self, *a, **k):
                calls.append(1)
                if len(calls) == 1:
                    raise RuntimeError("busy")
                return ("Chinese", "你好")

        fake = types.SimpleNamespace(Client=FakeClient, handle_file=lambda p: p)
        with mock.patch.dict(sys.modules, {"gradio_client": fake}), mock.patch.object(media.time, "sleep"), \
                mock.patch.object(config, "ASR_RETRIES", 2), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(media._asr_file(Path("a.m4a")), "（检测语言：Chinese）\n你好")
            # Every attempt failing raises with the last error.
            calls.clear()
            FakeClient.predict = lambda self, *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
            with self.assertRaisesRegex(RuntimeError, "after 2 attempts: down"):
                media._asr_file(Path("a.m4a"))

    def test_transcribe_uses_home_scratch_and_cleans_up(self):
        # Download and ASR mocked; the temp dir lives under HOME/tmp and is removed.
        made = []

        def fake_download(url, tmpdir):
            made.append(Path(tmpdir))
            p = Path(tmpdir) / "audio.m4a"
            p.write_bytes(b"x" * 2048)
            return p

        with mock.patch.object(media, "_download_audio", side_effect=fake_download), \
                mock.patch.object(media, "_asr_file", return_value="转写"), contextlib.redirect_stderr(io.StringIO()):
            out = media.transcribe({"url": "https://v.example/a.mp3", "title": "标题", "source": "https://v.example/p"})
        self.assertEqual(out, "# 标题（语音转写）\n来源: https://v.example/p\n\n转写")
        self.assertEqual(made[0].parent, self.home / "tmp")
        self.assertFalse(made[0].exists())


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nGUARD+MEDIA UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
