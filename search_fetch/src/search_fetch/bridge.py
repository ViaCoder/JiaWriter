"""search_fetch.bridge — the link between sf and the user's own Chrome.

Pages are opened by a Chrome extension (search_fetch/extension) inside the user's real,
everyday Chrome, so sites see a genuine browser: its own profile, history, GPU, fonts and
version — nothing is spoofed and no automation protocol is attached. Pieces:

  extension   MV3 service worker; opens pages in a dedicated window and runs the fixed
              page scripts in extension/ops/ (no code strings are evaluated)
  host        `sf bridge-host`, started BY CHROME through native messaging (stdio,
              32-bit native-order length + UTF-8 JSON); it also listens on a private Unix
              socket (<HOME>/bridge/bridge.sock, directory 0700, socket 0600)
  client      every `sf search` / `sf fetch` process sends one JSON request line to that
              socket and reads one JSON reply line. On Windows (and whenever
              SEARCH_FETCH_BRIDGE_FILE is set) the host is WriterAgent itself: it listens on a
              loopback port and writes {port, token} to a private file; every request line
              then carries the token.

`sf bridge install` copies the extension to <HOME>/extension (load it once in
chrome://extensions → Developer mode → Load unpacked) and writes the native-messaging
host manifest for this user's Chrome (Chrome only; the user does not use Chromium).
On Windows sf has no host of its own (Chrome registers native hosts in the registry
there, and WriterAgent already is the host), so install and bridge-host only explain that.
"""

# Async host and client.
import asyncio

# Extension id from its public key.
import base64
import hashlib

# Messages.
import json

# Paths, permissions, environment.
import os

# Copying the extension.
import shutil

# Socket connections from sync callers.
import socket

# Native framing.
import struct

# stdin/stdout of the host, argv.
import sys

# Path arithmetic.
from pathlib import Path

# Package home and run id.
from . import config

# Shared stderr logger.
from .config import _log

# Native messaging host name (lowercase letters, digits, dots and underscores only).
HOST_NAME = "com.writeragent.browser"
# The extension inside the package.
EXTENSION_SRC = Path(__file__).resolve().parent / "extension"
# Largest message the host may send to Chrome (Chrome's limit is 1 MB).
MAX_TO_CHROME = 1024 * 1024
# Largest reply line a client accepts (Chrome's limit towards the host is 64 MiB).
MAX_REPLY = 64 * 1024 * 1024
# Default per-request timeout (seconds).
DEFAULT_TIMEOUT = 60.0
# Instructions shown when the bridge is not reachable.
SETUP_HINT = ("Chrome with the search_fetch extension is not connected. Run `sf bridge install`, "
              "load the folder it prints in chrome://extensions (Developer mode → Load unpacked), "
              "and keep Chrome open.")
# On Windows the host is WriterAgent's, so the hint points there.
WINDOWS_HINT = ("On Windows the browser host is WriterAgent itself: load the chrome-extension folder of the "
                "WriterAgent package in chrome://extensions, keep Chrome open, and check it with /browser.")


class BridgeUnavailable(RuntimeError):
    """The host socket is missing or refuses connections (Chrome or the extension is not running)."""


class BridgeError(RuntimeError):
    """The extension answered with an error."""


def extension_id(manifest_path: Path = EXTENSION_SRC / "manifest.json") -> str:
    """Chrome's id for the extension: the first 32 hex digits of SHA-256 of its public key, mapped 0-f → a-p."""
    # The base64 DER public key fixed in the manifest.
    key = json.loads(manifest_path.read_text(encoding="utf-8"))["key"]
    # Hash of the key bytes.
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    # Chrome writes hex digits as the letters a–p.
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def bridge_dir() -> Path:
    """<HOME>/bridge (private: mode 0700)."""
    # Socket and launcher live here.
    return config.HOME / "bridge"


def socket_path() -> Path:
    """The host's Unix socket: SEARCH_FETCH_BRIDGE_SOCKET when set (WriterAgent's own host), else <HOME>/bridge."""
    # WriterAgent runs the host itself and tells sf where it listens.
    override = os.environ.get("SEARCH_FETCH_BRIDGE_SOCKET", "").strip()
    if override:
        return Path(override)
    # Inside the private directory.
    return bridge_dir() / "bridge.sock"


def address() -> tuple:
    """Where the host listens: ("tcp", <port file>) when SEARCH_FETCH_BRIDGE_FILE is set or on Windows,
    else ("unix", <socket path>)."""
    # WriterAgent's loopback host writes its port and token to this file.
    port_file = os.environ.get("SEARCH_FETCH_BRIDGE_FILE", "").strip()
    # A port file, given or the default one on Windows.
    if port_file or sys.platform == "win32":
        return ("tcp", Path(port_file) if port_file else bridge_dir() / "bridge.json")
    # The Unix socket.
    return ("unix", socket_path())


def _tcp_info(port_file: Path) -> tuple:
    """(port, token) from the host's port file; BridgeUnavailable when it is missing or unreadable."""
    # Read and check both fields.
    try:
        info = json.loads(port_file.read_text(encoding="utf-8"))
        port, token = int(info["port"]), str(info["token"])
    except (OSError, ValueError, KeyError, TypeError) as ex:
        # No file: the host is not running.
        raise BridgeUnavailable(WINDOWS_HINT if sys.platform == "win32" else SETUP_HINT) from ex
    # A real port only.
    if not 0 < port < 65536:
        raise BridgeUnavailable(SETUP_HINT)
    # Both values.
    return port, token


def installed_extension_dir() -> Path:
    """Where `sf bridge install` puts the extension (the folder to load in Chrome)."""
    # A stable path inside the package home.
    return config.HOME / "extension"


def host_manifest_dirs(platform: str = None, home: Path = None) -> list:
    """Chrome's NativeMessagingHosts directory for this user, as a one-item list (written even before
    Chrome is installed, so a later install finds the host)."""
    # Inputs.
    platform = platform or sys.platform
    home = home or Path.home()
    # Chrome's profile root per OS.
    root = home / "Library/Application Support/Google/Chrome" if platform == "darwin" else home / ".config/google-chrome"
    # The one folder.
    return [root / "NativeMessagingHosts"]


def _write_private(path: Path, text: str, mode: int) -> None:
    """Write text to path atomically with the given permission bits."""
    # Temp file next to the target.
    tmp = path.with_name(f".{path.name}.tmp")
    # Write it.
    tmp.write_text(text, encoding="utf-8")
    # Permissions before it becomes visible.
    os.chmod(tmp, mode)
    # Atomic replace.
    os.replace(tmp, path)


def launcher_script() -> str:
    """Shell script Chrome runs as the host: this interpreter running `python -m search_fetch bridge-host`
    with this package on the path and this HOME, so host and clients agree on the socket."""
    # Directory that contains the search_fetch package.
    pkg_parent = Path(__file__).resolve().parents[1]
    # POSIX sh, every value quoted.
    return "\n".join([
        "#!/bin/sh",
        "# search_fetch native messaging host launcher (written by `sf bridge install`).",
        f"export SEARCH_FETCH_HOME={json.dumps(str(config.HOME))}",
        f"export PYTHONPATH={json.dumps(str(pkg_parent))}${{PYTHONPATH:+:$PYTHONPATH}}",
        f"exec {json.dumps(sys.executable)} -m search_fetch bridge-host \"$@\"",
        "",
    ])


def install(platform: str = None, home: Path = None) -> dict:
    """Copy the extension to <HOME>/extension, write the launcher and the host manifests; return what was written."""
    # Windows: WriterAgent is the host.
    if (platform or sys.platform) == "win32":
        raise RuntimeError(WINDOWS_HINT)
    # Private bridge directory.
    d = bridge_dir()
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    # Fresh copy of the extension (replaces an older version).
    dest = installed_extension_dir()
    tmp = dest.with_name(".extension.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(EXTENSION_SRC, tmp)
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(tmp, dest)
    # Launcher, executable by this user only.
    launcher = d / "host.sh"
    _write_private(launcher, launcher_script(), 0o700)
    # The manifest Chrome reads.
    manifest = json.dumps({"name": HOST_NAME, "description": "search_fetch bridge host", "path": str(launcher),
                           "type": "stdio", "allowed_origins": [f"chrome-extension://{extension_id()}/"]}, indent=2)
    # One copy per browser directory.
    written = []
    for md in host_manifest_dirs(platform, home):
        md.mkdir(parents=True, exist_ok=True)
        target = md / f"{HOST_NAME}.json"
        _write_private(target, manifest + "\n", 0o644)
        written.append(str(target))
    # Report.
    return {"extension_dir": str(dest), "extension_id": extension_id(), "launcher": str(launcher), "manifests": written}


# ── native messaging framing ──────────────────────────────────────────

def encode_frame(obj) -> bytes:
    """One native messaging frame: 32-bit native-order length + UTF-8 JSON."""
    # Compact JSON.
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # Length prefix.
    return struct.pack("=I", len(body)) + body


def decode_length(prefix: bytes) -> int:
    """Body length from a 4-byte prefix."""
    # Native byte order, like Chrome.
    return struct.unpack("=I", prefix)[0]


# ── host (started by Chrome) ─────────────────────────────────────────

class Host:
    """Routes client requests to the extension (stdout) and its replies (stdin) back."""

    def __init__(self, out):
        # Binary stdout towards Chrome.
        self.out = out
        # Request id → future of the reply.
        self.pending = {}
        # Next request id.
        self.next_id = 1
        # Extension version from its hello message.
        self.version = None

    def send(self, msg: dict) -> None:
        """Write one frame to Chrome (refusing frames over Chrome's 1 MB limit)."""
        # Encoded frame.
        frame = encode_frame(msg)
        # Chrome drops oversized messages; refuse them here with a clear error.
        if len(frame) - 4 > MAX_TO_CHROME:
            raise BridgeError("request larger than Chrome's 1 MB native messaging limit")
        # Write and flush.
        self.out.write(frame)
        self.out.flush()

    def on_message(self, msg: dict) -> None:
        """Handle one message from the extension: hello, or a reply to a pending request."""
        # The extension introduces itself after connecting.
        if "hello" in msg:
            self.version = msg["hello"]
            _log(f"bridge: extension {self.version} connected")
            return
        # A reply resolves its request.
        fut = self.pending.pop(msg.get("id"), None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    async def request(self, op: str, args: dict, timeout: float) -> dict:
        """Send one command to the extension and wait for its reply."""
        # Id and future.
        rid = self.next_id
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        # Send; the reply arrives through on_message.
        try:
            self.send({"id": rid, "op": op, **args})
            return await asyncio.wait_for(fut, timeout)
        finally:
            # Never leak a pending entry.
            self.pending.pop(rid, None)

    async def handle_client(self, reader, writer) -> None:
        """One client connection: one JSON request line in, one JSON reply line out."""
        # Read, forward, answer; any failure becomes an error reply.
        try:
            req = json.loads(await reader.readline())
            reply = await self.request(str(req["op"]), dict(req.get("args") or {}), float(req.get("timeout") or DEFAULT_TIMEOUT))
        except asyncio.TimeoutError:
            reply = {"ok": False, "error": "timed out waiting for the extension"}
        except Exception as ex:
            reply = {"ok": False, "error": str(ex)}
        # One line back.
        writer.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
        # Deliver and close.
        try:
            await writer.drain()
        finally:
            writer.close()


async def _read_frames(reader, host: Host) -> None:
    """Feed every frame from Chrome to the host until stdin closes (Chrome or the extension went away)."""
    # One frame at a time.
    while True:
        # Length prefix; EOF ends the host.
        try:
            prefix = await reader.readexactly(4)
            body = await reader.readexactly(decode_length(prefix))
        except asyncio.IncompleteReadError:
            return
        # A malformed frame is skipped, not fatal.
        try:
            host.on_message(json.loads(body))
        except ValueError:
            _log("bridge: malformed message from the extension skipped")


async def serve(stdin, stdout, sock: Path) -> None:
    """Run the host: socket server for clients, frame reader for Chrome; return when Chrome closes stdin."""
    # Router.
    host = Host(stdout)
    # Private directory and a fresh socket.
    sock.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(sock.parent, 0o700)
    if sock.exists():
        sock.unlink()
    # Socket server for sf processes.
    server = await asyncio.start_unix_server(host.handle_client, path=str(sock))
    # Owner-only access.
    os.chmod(sock, 0o600)
    # Chrome's side of the pipe as an async stream.
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_REPLY)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), stdin)
    # Serve until Chrome disconnects.
    try:
        await _read_frames(reader, host)
    finally:
        # Stop accepting clients and remove the socket.
        server.close()
        await server.wait_closed()
        if sock.exists():
            sock.unlink()


def host_main(argv: list) -> int:
    """`sf bridge-host <origin>`: started by Chrome; refuses any caller but our extension."""
    # Windows: WriterAgent is the host.
    if sys.platform == "win32":
        _log(f"bridge-host: {WINDOWS_HINT}")
        return 2
    # Chrome passes the caller's origin first.
    origin = argv[0] if argv else ""
    # Only our extension may start the host.
    if origin.rstrip("/") != f"chrome-extension://{extension_id()}":
        _log(f"bridge-host: refusing caller {origin!r}")
        return 2
    # Serve on the binary stdio.
    asyncio.run(serve(sys.stdin.buffer, sys.stdout.buffer, socket_path()))
    # Chrome closed the pipe.
    return 0


# ── client (every sf process) ────────────────────────────────────────

def _reply_result(line: bytes):
    """Result of a reply line; BridgeError for an error reply."""
    # Parse.
    reply = json.loads(line or b"{}")
    # Error from the extension or the host.
    if not reply.get("ok"):
        raise BridgeError(reply.get("error") or "no reply from the extension")
    # The value.
    return reply.get("result")


def _request_line(op: str, args: dict, timeout: float, token: str = "") -> bytes:
    """One request line for the host (with the token of a loopback host)."""
    # Request fields.
    req = {"op": op, "args": args, "timeout": timeout}
    # The loopback host checks the token.
    if token:
        req["token"] = token
    # JSON plus newline.
    return json.dumps(req, ensure_ascii=False).encode("utf-8") + b"\n"


def _connect() -> tuple:
    """Blocking connection to the host: (socket, token); BridgeUnavailable when nobody listens."""
    # Where the host listens.
    kind, where = address()
    # Loopback port with a token.
    if kind == "tcp":
        port, token = _tcp_info(where)
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=10), token
        except OSError as ex:
            raise BridgeUnavailable(WINDOWS_HINT if sys.platform == "win32" else SETUP_HINT) from ex
    # Unix socket (no token: the socket's permissions guard it).
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(str(where))
    except (FileNotFoundError, ConnectionRefusedError) as ex:
        s.close()
        raise BridgeUnavailable(SETUP_HINT) from ex
    # Connected.
    return s, ""


def call(op: str, timeout: float = DEFAULT_TIMEOUT, **args):
    """Blocking request to the extension; BridgeUnavailable when Chrome/the extension is not connected."""
    # Connect to the host.
    s, token = _connect()
    try:
        # The host's own timeout plus a margin.
        s.settimeout(timeout + 10)
        # Send the request.
        s.sendall(_request_line(op, args, timeout, token))
        # Read one line.
        buf = b""
        while not buf.endswith(b"\n") and len(buf) < MAX_REPLY:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        # The result.
        return _reply_result(buf)
    finally:
        # Always close.
        s.close()


async def acall(op: str, timeout: float = DEFAULT_TIMEOUT, **args):
    """Async request to the extension (same contract as call)."""
    # Where the host listens.
    kind, where = address()
    token = ""
    # Connect.
    try:
        if kind == "tcp":
            port, token = _tcp_info(where)
            reader, writer = await asyncio.open_connection("127.0.0.1", port, limit=MAX_REPLY)
        else:
            reader, writer = await asyncio.open_unix_connection(str(where), limit=MAX_REPLY)
    except (FileNotFoundError, ConnectionRefusedError) as ex:
        raise BridgeUnavailable(WINDOWS_HINT if sys.platform == "win32" else SETUP_HINT) from ex
    # Send and read one line.
    try:
        writer.write(_request_line(op, args, timeout, token))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout + 10)
    finally:
        # Always close.
        writer.close()
    # The result.
    return _reply_result(line)


def status() -> dict:
    """{connected, version, windowId, tabs} of the bridge; connected False with the reason when it is down."""
    # Ask the extension.
    try:
        return {"connected": True, **call("status", timeout=10)}
    except (BridgeUnavailable, BridgeError, OSError) as ex:
        return {"connected": False, "error": str(ex)}
