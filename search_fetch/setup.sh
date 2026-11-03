#!/usr/bin/env bash
# search_fetch setup (one-click) — creates the venv + installs deps and PROVES the
# tool imports cleanly by running the entry point JiaWriter spawns (sf.py, through home/sf).
# A broken install therefore fails HERE, loudly, instead of inside a later web_search call.
#
# search_fetch is JiaWriter's JW_SEARCH=sf backend (a subprocess, JW_SF=<this dir>/home/sf);
# it uses no driver model (LLM) and needs no key.
#
# ALL runtime state lives INSIDE the package tree, under $SEARCH_FETCH_HOME (default
# <repo>/home): the venv, the extension copy, the bridge socket and caches. Nothing else lands in
# other directories on the machine — deleting the repo removes every trace. If the
# home dir is ever deleted, just re-run this script (idempotent; healthy re-runs
# are near-instant).
#
# Env knobs:  SEARCH_FETCH_HOME=<dir>   SEARCH_FETCH_REINSTALL=1 (force dep reinstall)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SEARCH_FETCH_HOME="${SEARCH_FETCH_HOME:-$DIR/home}"
VENV="$SEARCH_FETCH_HOME/venv"
PYBIN="$VENV/bin/python3"

# The pinned, validated dependency set lives in ONE place — pyproject.toml
# [project.dependencies] — shared by this dev setup, the wheel, and the PyApp
# release packaging. Bump pins there, deliberately.
# Document parsing (docparse.py): pypdf→pdf text, openpyxl→xlsx, markitdown→pptx/docx (text layers, no OCR).

# ── tiny progress helpers (phase counter + elapsed seconds) ──────────
STEP=0; TOTAL=5
step(){ STEP=$((STEP+1)); printf '\n[%d/%d] %s  (+%ds)\n' "$STEP" "$TOTAL" "$1" "$SECONDS"; }
heartbeat(){ # run "$@" while printing dots so a long pip step never looks hung
  "$@" & local pid=$!
  while kill -0 "$pid" 2>/dev/null; do printf '.'; sleep 3; done
  printf '\n'; wait "$pid"
}

echo "==> search_fetch setup   dir=$DIR   home=$SEARCH_FETCH_HOME"
mkdir -p "$SEARCH_FETCH_HOME"
export PIP_CACHE_DIR="$SEARCH_FETCH_HOME/pip-cache"   # pip cache stays inside the package too

# ── 1. Python 3.10+ ──────────────────────────────────────────────────
step "Locating Python 3.10+"
PY=""
for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  p="$(command -v "$c" 2>/dev/null)" || continue
  if "$p" -c 'import sys; raise SystemExit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then PY="$p"; break; fi
done
[ -z "$PY" ] && { echo "✗ Python 3.10+ required."; exit 1; }
echo "    python: $PY"

# ── 2. Chrome / Chromium (platform-aware; engine auto-detects too) ───
step "Locating Chrome / Chromium"
CHROME=""
case "$(uname -s)" in
  Darwin) for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
                   "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
            [ -x "$c" ] && CHROME="$c" && break; done ;;
  *)      for c in google-chrome google-chrome-stable chromium chromium-browser chrome; do
            p="$(command -v "$c" 2>/dev/null)" && CHROME="$p" && break; done ;;
esac
[ -n "$CHROME" ] && echo "    chrome: $CHROME" \
  || echo "    chrome: not found — install Google Chrome (search/fetch run in YOUR Chrome via the extension)"

# ── 3. venv + packages (under $SEARCH_FETCH_HOME, inside the repo) ──────────
#   bs4 + lxml + snowballstemmer — crawl4ai's renderer and filters (copied into vendor/crawl4ai): HTML → markdown (_raw + pruned/BM25 _fit).
step "Python venv + dependencies"
# venv creation takes ONE path everywhere: `--without-pip` (never needs the system
# ensurepip, which Debian/Ubuntu split into python3-venv) + get-pip.py bootstrap.
# Readiness = the venv's pip imports; anything less is rebuilt wholesale, which is
# idempotent and also repairs a half-created venv from an interrupted earlier run.
if ! "$PYBIN" -m pip --version >/dev/null 2>&1; then
  echo "    venv: (re)initialising at $VENV"
  rm -rf "$VENV"
  if ! venv_err="$("$PY" -m venv --without-pip "$VENV" 2>&1)"; then
    echo "✗ Could not create the Python venv:"; printf '%s\n' "$venv_err" | sed 's/^/    /'
    exit 1
  fi
  gp="$SEARCH_FETCH_HOME/get-pip.py"
  if command -v curl >/dev/null 2>&1; then curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$gp"
  else wget -qO "$gp" https://bootstrap.pypa.io/get-pip.py; fi \
    || { echo "✗ could not download get-pip.py (network required)"; exit 1; }
  "$PYBIN" "$gp" -q || { rm -f "$gp"; echo "✗ pip bootstrap failed."; exit 1; }
  rm -f "$gp"
fi
[ -x "$PYBIN" ] || { echo "✗ venv built but $PYBIN is missing."; exit 1; }

# Fast path: if the deps already import cleanly, skip the (slow) pip step entirely.
# Force a reinstall with SEARCH_FETCH_REINSTALL=1.
deps_ok(){ "$PYBIN" - <<'PYCHK' >/dev/null 2>&1
import bs4, lxml, snowballstemmer, idna  # noqa  (vendor/crawl4ai renderer and filters, url_guard)
import pypdf, openpyxl  # noqa  (docparse parsing)
import yt_dlp  # noqa  (media: metadata + YouTube subtitles)
import numpy, requests, tiktoken  # noqa  (kb.py, the "kb" extra: embeddings index + retrieval)
PYCHK
}
if [ "${SEARCH_FETCH_REINSTALL:-0}" != "1" ] && deps_ok; then
  echo "    ✓ dependencies already present — skipping install (SEARCH_FETCH_REINSTALL=1 to force)"
else
  echo "    installing pinned deps from pyproject.toml"
  echo "    (first run pulls ~300MB — a few minutes; dots = progress)"
  "$VENV/bin/pip" install -q --upgrade pip || true
  # --prefer-binary avoids slow source builds (lxml, pydantic-core, …); cache kept for re-runs.
  # Installing the package itself pulls the SAME pinned set the release wheel embeds.
  if ! heartbeat "$VENV/bin/pip" install -q --prefer-binary "$DIR[kb]"; then
    echo "✗ pip install failed (see output above). Common fix: ensure build tools / network access."
    exit 1
  fi
  deps_ok && echo "    ✓ imports OK (renderer, docparse/media/kb deps)" \
          || { echo "✗ deps installed but import check failed."; exit 1; }
fi

# ── 4. rag.env (optional knobs; the real environment always wins) ────────────
step "Config (rag.env)"
if [ ! -f "$DIR/rag.env" ]; then
  cp "$DIR/rag.env.template" "$DIR/rag.env"
  echo "    created $DIR/rag.env from template (optional knobs, all commented out)"
else
  echo "    ✓ rag.env present"
fi

# ── 5. Launcher for JiaWriter (JW_SF) + verify the entry point ─────────────
# home/sf runs this source tree under the venv with this HOME; JiaWriter's JW_SF points here.
cat > "$SEARCH_FETCH_HOME/sf" <<LAUNCH
#!/bin/sh
SEARCH_FETCH_HOME="$SEARCH_FETCH_HOME" exec "$PYBIN" "$DIR/sf.py" "\$@"
LAUNCH
chmod 700 "$SEARCH_FETCH_HOME/sf"
step "Verify: sf.py imports + runs under the venv"
if SEARCH_FETCH_HOME="$SEARCH_FETCH_HOME" "$PYBIN" "$DIR/sf.py" browser status --json >/dev/null 2>&1; then
  echo "    ✓ sf.py OK under $PYBIN"
else
  echo "✗ sf.py failed under the venv — re-run after fixing:  SEARCH_FETCH_REINSTALL=1 bash setup.sh"
  exit 1
fi
# The Chrome extension bridge: copies the extension into $SEARCH_FETCH_HOME and writes
# Chrome's native-messaging host manifest (one json file in Chrome's config dir).
if SEARCH_FETCH_HOME="$SEARCH_FETCH_HOME" "$PYBIN" "$DIR/sf.py" bridge install >/dev/null 2>&1; then
  echo "    ✓ bridge installed — load $SEARCH_FETCH_HOME/extension once in chrome://extensions"
  echo "      (Developer mode → Load unpacked), keep Chrome open; check: sf.py bridge status"
else
  echo "    ! bridge install failed — run: SEARCH_FETCH_HOME=\"$SEARCH_FETCH_HOME\" $PYBIN $DIR/sf.py bridge install"
fi

cat <<EOF

==> Setup complete in ${SECONDS}s.
    JiaWriter wiring:
      JW_SEARCH=sf
      JW_SF=$SEARCH_FETCH_HOME/sf

    Direct self-test (no key needed):
      SEARCH_FETCH_HOME="$SEARCH_FETCH_HOME" "$PYBIN" "$DIR/sf.py" fetch '<url>'
      SEARCH_FETCH_HOME="$SEARCH_FETCH_HOME" "$PYBIN" "$DIR/sf.py" search '<query>' --pages 1

    Where things land:
      • Per-call results → ./.search_fetchres/ in the CALLING directory (JiaWriter runs
        sf with cwd = the writing folder, so scrape records stay in that folder).
      • venv + launcher + extension copy + bridge socket + pacing + caches → $SEARCH_FETCH_HOME.
EOF
