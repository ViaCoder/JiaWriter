#!/usr/bin/env python3
"""The Chrome extension bridge (search_fetch.bridge) — stdlib only, no browser, no network.

Covers the extension id derivation, paths, host-manifest locations per OS, the installer
(files, modes, manifest fields, launcher), native-messaging framing, the host's routing,
and a protocol run end to end: the real host serves a real Unix socket, a thread plays the
extension on the pipes Chrome would own, and sf clients (sync and async) get their replies.
Also the loopback client of WriterAgent's Windows host (port file plus token).
Run: python3 tests/test_bridge.py
"""
# Async host and client.
import asyncio
import contextlib
import io
import json
import os
import shutil
import stat
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import bridge, config  # noqa: E402

# Scratch root inside the repository (short paths: Unix socket names are length-limited).
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


def fake_extension(read_fd: int, write_fd: int, stop: threading.Event) -> None:
    """Play the extension on Chrome's pipe ends: hello, then answer each command."""
    # Binary streams.
    rd, wr = os.fdopen(read_fd, "rb", buffering=0), os.fdopen(write_fd, "wb", buffering=0)
    # Introduce ourselves.
    wr.write(bridge.encode_frame({"hello": "test-1"}))
    # Serve until the host goes away.
    while not stop.is_set():
        prefix = rd.read(4)
        if len(prefix) < 4:
            break
        msg = json.loads(rd.read(bridge.decode_length(prefix)))
        # A command that fails, one that never answers, and an echo.
        if msg["op"] == "boom":
            wr.write(bridge.encode_frame({"id": msg["id"], "ok": False, "error": "kaboom"}))
        elif msg["op"] == "silent":
            continue
        else:
            wr.write(bridge.encode_frame({"id": msg["id"], "ok": True, "result": {"op": msg["op"], "url": msg.get("url")}}))
    # Closing Chrome's write end ends the host.
    wr.close()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        # Short scratch HOME.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="br-", dir=str(_TMP_ROOT)))
        self.patch = mock.patch.object(config, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        # Restore.
        self.patch.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_extension_id_matches_the_manifest_key(self):
        # Derived from the shipped key; 32 letters a–p.
        eid = bridge.extension_id()
        self.assertEqual(eid, "mnoicnfoocibanokjfbpmbgpamlmdgje")
        self.assertTrue(len(eid) == 32 and set(eid) <= set("abcdefghijklmnop"))

    def test_paths(self):
        # Everything under HOME.
        self.assertEqual(bridge.bridge_dir(), self.home / "bridge")
        self.assertEqual(bridge.socket_path(), self.home / "bridge" / "bridge.sock")
        self.assertEqual(bridge.installed_extension_dir(), self.home / "extension")

    def test_host_manifest_dirs(self):
        # Chrome's folder only, also when a Chromium profile exists.
        fake = self.home / "u"
        mac = bridge.host_manifest_dirs("darwin", fake)
        self.assertEqual(mac, [fake / "Library/Application Support/Google/Chrome/NativeMessagingHosts"])
        (fake / ".config/chromium").mkdir(parents=True)
        self.assertEqual(bridge.host_manifest_dirs("linux", fake), [fake / ".config/google-chrome/NativeMessagingHosts"])

    def test_write_private(self):
        # Content and mode, no temp file left.
        p = self.home / "f.txt"
        bridge._write_private(p, "x", 0o600)
        self.assertEqual((p.read_text(), stat.S_IMODE(p.stat().st_mode)), ("x", 0o600))
        self.assertEqual([q.name for q in self.home.iterdir()], ["f.txt"])

    def test_launcher_script(self):
        # Exports HOME and the package path, execs this interpreter.
        sh = bridge.launcher_script()
        self.assertTrue(sh.startswith("#!/bin/sh\n"))
        self.assertIn(f'export SEARCH_FETCH_HOME="{self.home}"', sh)
        self.assertIn(f'exec "{sys.executable}" -m search_fetch bridge-host "$@"', sh)

    def test_install(self):
        # Extension copied, launcher private, manifest correct.
        rep = bridge.install("linux", self.home / "u")
        ext = Path(rep["extension_dir"])
        self.assertTrue((ext / "manifest.json").is_file() and (ext / "ops" / "results.js").is_file())
        self.assertEqual(stat.S_IMODE(Path(rep["launcher"]).stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(bridge.bridge_dir().stat().st_mode), 0o700)
        m = json.loads(Path(rep["manifests"][0]).read_text())
        self.assertEqual(m, {"name": "com.writeragent.browser", "description": "search_fetch bridge host",
                             "path": rep["launcher"], "type": "stdio",
                             "allowed_origins": ["chrome-extension://mnoicnfoocibanokjfbpmbgpamlmdgje/"]})
        # A second install replaces the copy.
        (ext / "stale.js").write_text("x")
        bridge.install("linux", self.home / "u")
        self.assertFalse((ext / "stale.js").exists())

    def test_framing(self):
        # Native-order 32-bit length + compact UTF-8 JSON.
        frame = bridge.encode_frame({"a": "中"})
        self.assertEqual(frame[4:], '{"a":"中"}'.encode())
        self.assertEqual(bridge.decode_length(frame[:4]), len(frame) - 4)
        self.assertEqual(frame[:4], struct.pack("=I", len(frame) - 4))

    def test_host_send_on_message_and_request(self):
        # send writes a frame; oversized requests are refused; replies resolve requests; hello records the version.
        out = io.BytesIO()
        h = bridge.Host(out)
        h.send({"id": 1, "op": "x"})
        self.assertEqual(json.loads(out.getvalue()[4:]), {"id": 1, "op": "x"})
        with self.assertRaises(bridge.BridgeError):
            h.send({"big": "x" * (bridge.MAX_TO_CHROME + 1)})
        with contextlib.redirect_stderr(io.StringIO()):
            h.on_message({"hello": "9"})
        self.assertEqual(h.version, "9")

        # The id the next request will use.
        rid = h.next_id

        async def go():
            # The reply arrives while request() waits.
            task = asyncio.create_task(h.request("open", {"url": "u"}, 2))
            await asyncio.sleep(0)
            h.on_message({"id": rid, "ok": True, "result": 5})
            return await task
        out.seek(0), out.truncate()
        self.assertEqual(asyncio.run(go()), {"id": rid, "ok": True, "result": 5})
        # The command reached Chrome's side with that id.
        self.assertEqual(json.loads(out.getvalue()[4:]), {"id": rid, "op": "open", "url": "u"})
        self.assertEqual(h.pending, {})

    def test_host_main_refuses_other_callers(self):
        # Only our extension's origin may start the host.
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bridge.host_main(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]), 2)
            self.assertEqual(bridge.host_main([]), 2)

    def test_client_without_host(self):
        # No socket: a clear BridgeUnavailable; status reports disconnected.
        with self.assertRaises(bridge.BridgeUnavailable):
            bridge.call("status")
        with self.assertRaises(bridge.BridgeUnavailable):
            asyncio.run(bridge.acall("status"))
        self.assertFalse(bridge.status()["connected"])

    def test_reply_and_request_lines(self):
        # Error replies raise; the request line is one JSON object.
        self.assertEqual(bridge._reply_result(b'{"ok":true,"result":3}'), 3)
        with self.assertRaisesRegex(bridge.BridgeError, "nope"):
            bridge._reply_result(b'{"ok":false,"error":"nope"}')
        self.assertEqual(json.loads(bridge._request_line("open", {"url": "u"}, 5)), {"op": "open", "args": {"url": "u"}, "timeout": 5})

    def test_address(self):
        # Unix socket by default; a port file when SEARCH_FETCH_BRIDGE_FILE is set or on Windows.
        with mock.patch.dict(os.environ, {"SEARCH_FETCH_BRIDGE_FILE": "", "SEARCH_FETCH_BRIDGE_SOCKET": ""}):
            self.assertEqual(bridge.address(), ("unix", self.home / "bridge" / "bridge.sock"))
            with mock.patch.object(bridge.sys, "platform", "win32"):
                self.assertEqual(bridge.address(), ("tcp", self.home / "bridge" / "bridge.json"))
        with mock.patch.dict(os.environ, {"SEARCH_FETCH_BRIDGE_FILE": str(self.home / "p.json")}):
            self.assertEqual(bridge.address(), ("tcp", self.home / "p.json"))

    def test_tcp_info(self):
        # Missing file and bad port: not connected; a good file gives port and token.
        p = self.home / "p.json"
        with self.assertRaises(bridge.BridgeUnavailable):
            bridge._tcp_info(p)
        p.write_text(json.dumps({"port": 0, "token": "t"}), encoding="utf-8")
        with self.assertRaises(bridge.BridgeUnavailable):
            bridge._tcp_info(p)
        p.write_text(json.dumps({"port": 4321, "token": "ab"}), encoding="utf-8")
        self.assertEqual(bridge._tcp_info(p), (4321, "ab"))

    def test_request_line_with_token(self):
        # The loopback host's token rides in the request; none without it.
        self.assertEqual(json.loads(bridge._request_line("status", {}, 3, "tok"))["token"], "tok")
        self.assertNotIn("token", json.loads(bridge._request_line("status", {}, 3)))

    def test_tcp_client_end_to_end(self):
        # A loopback host like WriterAgent's on Windows: one JSON line in, one out, token checked.
        import socketserver
        token = "f" * 64

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                req = json.loads(self.rfile.readline())
                ok = req.get("token") == token
                reply = {"ok": True, "result": {"op": req["op"], **req["args"]}} if ok else {"ok": False, "error": "bad token"}
                self.wfile.write(json.dumps(reply).encode() + b"\n")

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port_file = self.home / "bridge.json"
        try:
            port_file.write_text(json.dumps({"port": srv.server_address[1], "token": token}), encoding="utf-8")
            with mock.patch.dict(os.environ, {"SEARCH_FETCH_BRIDGE_FILE": str(port_file)}):
                # Sync and async clients.
                self.assertEqual(bridge.call("open", url="u"), {"op": "open", "url": "u"})
                self.assertEqual(asyncio.run(bridge.acall("status")), {"op": "status"})
                # A wrong token is refused by the host.
                port_file.write_text(json.dumps({"port": srv.server_address[1], "token": "bad"}), encoding="utf-8")
                with self.assertRaisesRegex(bridge.BridgeError, "bad token"):
                    bridge.call("status")
        finally:
            srv.shutdown()
            srv.server_close()
        # Nobody listens on the port any more: not connected.
        with mock.patch.dict(os.environ, {"SEARCH_FETCH_BRIDGE_FILE": str(port_file)}):
            with self.assertRaises(bridge.BridgeUnavailable):
                bridge.call("status")
            with self.assertRaises(bridge.BridgeUnavailable):
                asyncio.run(bridge.acall("status"))

    def test_windows_has_no_own_host(self):
        # On Windows WriterAgent is the host: install refuses, bridge-host explains and exits 2.
        with self.assertRaisesRegex(RuntimeError, "WriterAgent"):
            bridge.install("win32", self.home / "u")
        with mock.patch.object(bridge.sys, "platform", "win32"), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(bridge.host_main([f"chrome-extension://{bridge.extension_id()}/"]), 2)
        self.assertIn("/browser", err.getvalue())
        self.assertFalse((self.home / "u").exists())

    def test_protocol_end_to_end(self):
        # Pipes Chrome would own: host reads ext→host, writes host→ext.
        to_host_r, to_host_w = os.pipe()
        to_ext_r, to_ext_w = os.pipe()
        stop = threading.Event()
        ext = threading.Thread(target=fake_extension, args=(to_ext_r, to_host_w, stop), daemon=True)
        ext.start()
        sock = bridge.socket_path()
        results = {}

        async def scenario():
            # The real host on the pipes.
            stdin = os.fdopen(to_host_r, "rb", buffering=0)
            stdout = os.fdopen(to_ext_w, "wb", buffering=0)
            server = asyncio.create_task(bridge.serve(stdin, stdout, sock))
            # Wait for the socket.
            for _ in range(100):
                if sock.exists():
                    break
                await asyncio.sleep(0.02)
            results["mode"] = stat.S_IMODE(sock.stat().st_mode)
            # Async client: success, extension error, timeout.
            results["async"] = await bridge.acall("open", url="https://example.com/")
            with self.assertRaisesRegex(bridge.BridgeError, "kaboom"):
                await bridge.acall("boom")
            with self.assertRaisesRegex(bridge.BridgeError, "timed out"):
                await bridge.acall("silent", timeout=0.3)
            # Sync client from a worker thread (it blocks).
            results["sync"] = await asyncio.to_thread(bridge.call, "status")
            results["status"] = await asyncio.to_thread(bridge.status)
            # Chrome goes away: the host returns and removes its socket.
            stop.set()
            stdout.close()
            await asyncio.wait_for(server, 5)
            results["sock_after"] = sock.exists()

        with contextlib.redirect_stderr(io.StringIO()):
            asyncio.run(scenario())
        ext.join(5)
        self.assertEqual(results["mode"], 0o600)
        self.assertEqual(results["async"], {"op": "open", "url": "https://example.com/"})
        self.assertEqual(results["sync"]["op"], "status")
        self.assertTrue(results["status"]["connected"])
        self.assertFalse(results["sock_after"])


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nBRIDGE:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
