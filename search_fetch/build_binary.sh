#!/usr/bin/env bash
# Build search_fetch as a single PyApp binary for this machine (Linux, macOS or Windows; amd64 or arm64).
#
# The binary embeds the search_fetch wheel (with its pinned dependencies) and a CPython 3.12
# distribution; on first run it installs the dependencies into the folder named by
# PYAPP_INSTALL_DIR_SEARCH_FETCH (WriterAgent sets it under ~/.writeragent/agent/sf/).
# The release workflow runs this on one native runner per platform (on Windows under Git Bash).
#
# Usage: bash search_fetch/build_binary.sh [--out <dir>]
#   Output: <out>/<os>/<arch>/sf, or sf.exe on Windows   (default <out>: <repo>/.tmp/sf/dist)
# Needs: cargo, curl, perl, and a Python with pip (PYTHON, default python3) to build the wheel.
set -euo pipefail

# This folder and the repository root.
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# Output folder.
OUT="$ROOT/.tmp/sf/dist"
if [ "${1:-}" = "--out" ]; then OUT="$2"; fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Work folder for the wheel and the PyApp source.
WORK="$ROOT/.tmp/sf/build"
mkdir -p "$WORK"
# Pinned PyApp source (release asset digest from the GitHub API). pyapp/Cargo.toml and pyapp/Cargo.lock
# replace the upstream ones: zip 9 and zstd 0.14 instead of 6 and 0.13, and bytes, quinn-proto, rustls,
# tar and time raised to their fixed versions, so cargo audit finds no vulnerability (2026-11-01).
PYAPP_VERSION="0.31.0"
PYAPP_SHA256="16bc883dd936584eef8d0d838feef3e839c340f201f36cc05eb810f29df92c22"
PYTHON="${PYTHON:-python3}"
# Windows (Git Bash): cargo's build script is a native program and needs C:\ style paths.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }

# 1. The wheel; dependency pins travel in its metadata.
echo "==> wheel"
rm -rf "$WORK/wheel"
"$PYTHON" -m pip wheel --no-deps -q -w "$WORK/wheel" "$DIR"
WHEEL="$(ls "$WORK"/wheel/search_fetch-*.whl)"

# 2. PyApp source, checked against the pinned digest.
TARBALL="$WORK/pyapp-v$PYAPP_VERSION.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL "https://github.com/ofek/pyapp/releases/download/v$PYAPP_VERSION/source.tar.gz" -o "$TARBALL.part"
  mv "$TARBALL.part" "$TARBALL"
fi
ACTUAL="$("$PYTHON" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TARBALL")"
if [ "$ACTUAL" != "$PYAPP_SHA256" ]; then
  rm -f "$TARBALL"
  echo "error: PyApp source SHA256 $ACTUAL does not match $PYAPP_SHA256" >&2
  exit 1
fi
SRC="$WORK/pyapp-v$PYAPP_VERSION"
rm -rf "$SRC"
tar -xzf "$TARBALL" -C "$WORK"
# The audited manifest and lockfile.
cp -f "$DIR/pyapp/Cargo.toml" "$DIR/pyapp/Cargo.lock" "$SRC/"

# 3. Two source patches, each checked: the cache folder follows PYAPP_CACHE_DIR (upstream always uses
#    ~/.cache/pyapp), and the install-folder variable uses underscores (PYAPP_INSTALL_DIR_SEARCH_FETCH;
#    PEP 503 turns the project name into search-fetch, and a hyphen cannot be exported in a shell).
perl -0pi -e 's/pub fn cache_dir\(\) -> PathBuf \{\n    platform_dirs\(\)\.cache_dir\(\)\.to_path_buf\(\)\n\}/pub fn cache_dir() -> PathBuf {\n    match env::var("PYAPP_CACHE_DIR") {\n        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),\n        _ => platform_dirs().cache_dir().to_path_buf(),\n    }\n}/s' "$SRC/src/app.rs"
grep -q "PYAPP_CACHE_DIR" "$SRC/src/app.rs" || { echo "error: cache_dir patch did not apply" >&2; exit 1; }
perl -0pi -e 's/"PYAPP_INSTALL_DIR_\{\}",\n        project_name\(\)\.to_uppercase\(\)/"PYAPP_INSTALL_DIR_{}",\n        project_name().to_uppercase().replace('"'"'-'"'"', "_")/s' "$SRC/src/app.rs"
grep -q "replace('-', \"_\")" "$SRC/src/app.rs" || { echo "error: install-dir patch did not apply" >&2; exit 1; }

# 4. Build-time configuration burnt into the binary.
export PYAPP_PROJECT_NAME="search_fetch"
PYAPP_PROJECT_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$DIR/pyproject.toml" | head -n 1)"
export PYAPP_PROJECT_VERSION
PYAPP_PROJECT_PATH="$(native_path "$WHEEL")"
export PYAPP_PROJECT_PATH
export PYAPP_EXEC_MODULE="search_fetch"
export PYAPP_PYTHON_VERSION="3.12"
export PYAPP_DISTRIBUTION_EMBED="1"
export PYAPP_PIP_EXTRA_ARGS="--prefer-binary"
export PYAPP_EXPOSE_PYTHON="1" PYAPP_EXPOSE_PIP="1"

# 5. Native build and placement under <os>/<arch>.
( cd "$SRC" && cargo build --release --locked --quiet )
# Operating system; on Windows the binary has the .exe suffix.
exe=""
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  MINGW*|MSYS*|CYGWIN*) os=windows; exe=".exe" ;;
  *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
# CPU of the compiled binary: rustc's host triple (uname -m reports the shell's CPU, which on
# Windows on Arm can be an emulated x86_64 Git Bash).
host="$(rustc -vV | sed -n 's/^host: //p')"
case "$host" in x86_64-*) arch=amd64 ;; aarch64-*) arch=arm64 ;; *) echo "error: unsupported target $host" >&2; exit 1 ;; esac
mkdir -p "$OUT/$os/$arch"
cp -f "$SRC/target/release/pyapp$exe" "$OUT/$os/$arch/sf$exe"
chmod 0755 "$OUT/$os/$arch/sf$exe"
echo "==> $OUT/$os/$arch/sf$exe ($(du -h "$OUT/$os/$arch/sf$exe" | awk '{print $1}'))"
