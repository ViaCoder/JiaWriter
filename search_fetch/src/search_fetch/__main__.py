"""search_fetch.__main__ — the ONE package entry point behind every launcher:
`python -m search_fetch`, the dev shim `sf.py`, the venv console script `sf`,
and the PyApp release binary (PYAPP_EXEC_MODULE=search_fetch).

Seeds the environment from rag.env before importing search_fetch.cli (config.py
freezes its knobs from the environment at import time). Real env always wins;
rag.env only fills gaps. The driver-model names SF_URL / SF_KEY / SF_MODEL are
reserved (old SEARCH_FETCH_LLM_* names are refused) for when a model is added back.
Standard output and error are UTF-8 on every system (Windows pipes default to the ANSI
code page, which cannot hold Chinese text or "→"). Stdlib-only until the CLI runs.
"""
# Process environment and exit codes.
import os

# stderr for the stale-name message.
import sys

# Path arithmetic for rag.env.
from pathlib import Path

# Driver-model variables renamed on 2026-11-01 (old name -> new name). The old names are
# rejected at startup so a stale export or rag.env line never fails silently.
RENAMED = {
    # Base URL of the driver-model endpoint (wire API chosen by SF_API).
    "SEARCH_FETCH_LLM_BASE_URL": "SF_URL",
    # API key of the driver endpoint.
    "SEARCH_FETCH_LLM_API_KEY": "SF_KEY",
    # Driver model id.
    "SEARCH_FETCH_LLM_MODEL": "SF_MODEL",
}

# Exit code for a configuration error (sysexits EX_CONFIG).
EXIT_CONFIG = 78


def _env_file() -> Path:
    """rag.env location, ONE rule: the sibling of the state home dir —
    `$SEARCH_FETCH_HOME/../rag.env`. Unset SEARCH_FETCH_HOME means the
    source-checkout default home (<repo>/home), so the file is <repo>/rag.env;
    the release run.sh always sets SEARCH_FETCH_HOME=<pkg>/search_fetch/home,
    so the file is <pkg>/search_fetch/rag.env."""
    # State home chosen by the launcher, if any.
    home = os.environ.get("SEARCH_FETCH_HOME")
    # Its parent, or the repository root for a source checkout.
    base = Path(home).parent if home else Path(__file__).resolve().parents[2]
    # rag.env sits next to the home directory.
    return base / "rag.env"


def _read_env_file(path: Path) -> dict:
    """NAME=value pairs of an env file ({} when it does not exist); comments and blank lines skipped."""
    # Collected pairs.
    pairs = {}
    # A missing file contributes nothing.
    if not path.is_file():
        return pairs
    # One assignment per line.
    for line in path.read_text(encoding="utf-8").splitlines():
        # Surrounding whitespace is not significant.
        line = line.strip()
        # Only non-comment lines with an "=".
        if line and not line.startswith("#") and "=" in line:
            # Split at the first "=".
            k, _, v = line.partition("=")
            # An optional "export " prefix is allowed.
            k = k.strip().removeprefix("export ").strip()
            # Quotes around the value are dropped.
            pairs[k] = v.strip().strip('"').strip("'")
    # The pairs.
    return pairs


def _stale_names(environ, file_pairs: dict) -> list:
    """Renamed variables still set in the environment or in rag.env, in RENAMED order."""
    # A name counts when either source sets it.
    return [old for old in RENAMED if old in environ or old in file_pairs]


def _stale_message(stale: list, path: Path) -> str:
    """Chinese error for stale names: old -> new per line; names only, never values."""
    # Header line.
    lines = ["search_fetch 的驾驶模型变量已改名，请改用新名后再运行（旧名不再生效）："]
    # One mapping per stale name.
    lines += [f"  {old} → {RENAMED[old]}" for old in stale]
    # Where to look.
    lines.append(f"请检查环境变量和 {path}。")
    # One block of text.
    return "\n".join(lines)


def _load_env() -> None:
    """Seed os.environ from rag.env; variables already set win."""
    # Fill only the gaps.
    for k, v in _read_env_file(_env_file()).items():
        # Real environment always wins.
        os.environ.setdefault(k, v)


def _utf8_stdio(streams=None) -> None:
    """Switch the text streams (default stdout and stderr) to UTF-8; binary use through .buffer is unchanged."""
    # Both standard text streams.
    for stream in streams if streams is not None else (sys.stdout, sys.stderr):
        # Only real text streams can be reconfigured (a test may replace them).
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def main(argv=None) -> int:
    # UTF-8 output whatever the console or pipe code page is.
    _utf8_stdio()
    # rag.env of this run.
    path = _env_file()
    # Old driver-model names anywhere stop the run with a clear message.
    stale = _stale_names(os.environ, _read_env_file(path))
    # Report and exit with the configuration-error code.
    if stale:
        # Names only on stderr.
        print(_stale_message(stale, path), file=sys.stderr)
        # EX_CONFIG.
        return EXIT_CONFIG
    # Fill the environment from rag.env.
    _load_env()
    # Import late: config.py reads the environment at import time.
    from search_fetch.cli import main as cli_main
    # Run the CLI.
    return cli_main(argv)


if __name__ == "__main__":
    # Exit with the CLI's code.
    sys.exit(main())
