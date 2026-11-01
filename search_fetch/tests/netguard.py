#!/usr/bin/env python3
"""Run a test script with outbound networking blocked: every socket connect that is not
loopback raises OSError and prints `NETGUARD outbound connect to <host>` on stderr, so a
test that reaches a real website (an unmocked OCR Space, an engine, a CDN) fails at once.
Usage: python3 tests/netguard.py tests/test_x.py [args…]   (tests/run_all.sh runs every suite this way)
"""
import runpy  # Running the target script as __main__.
import socket  # Socket patching.
import sys  # Arguments and stderr.

# The real connect.
_ORIG_CONNECT = socket.socket.connect


def _is_loopback(addr) -> bool:
    """True for Unix sockets and loopback addresses."""
    # A Unix socket path (the bridge socket, multiprocessing).
    if isinstance(addr, (str, bytes)):
        return True
    # Host part of (host, port[, …]).
    host = str(addr[0])
    # IPv4 loopback, IPv6 loopback, the name localhost.
    return host.startswith("127.") or host in ("::1", "localhost")


def _guarded_connect(self, addr):
    """Allow loopback; refuse and report everything else."""
    # Outbound: report and refuse before any packet is sent.
    if not _is_loopback(addr):
        sys.stderr.write(f"NETGUARD outbound connect to {addr[0]}\n")
        raise OSError("outbound network blocked in tests (tests/netguard.py)")
    # Loopback goes through.
    return _ORIG_CONNECT(self, addr)


def main() -> None:
    # The script to run and its arguments.
    if len(sys.argv) < 2:
        sys.stderr.write("usage: netguard.py <test script> [args…]\n")
        sys.exit(2)
    # Patch before the test imports anything.
    socket.socket.connect = _guarded_connect
    # The script sees its own argv.
    sys.argv = sys.argv[1:]
    # Run it as the main module.
    runpy.run_path(sys.argv[0], run_name="__main__")


if __name__ == "__main__":
    # Entry.
    main()
