#!/usr/bin/env bash
# Build search_fetch as a single PyApp binary for this machine (Linux, macOS or Windows; amd64 or arm64).
#
# The binary is a bundle: it embeds a CPython 3.12 distribution with search_fetch and every dependency
# already installed. On first run it only unpacks that copy into the folder named by
# PYAPP_INSTALL_DIR_SEARCH_FETCH (WriterAgent sets it under ~/.writeragent/agent/sf/): no network,
# no pip, no virtual environment on the user's machine.
# The release workflow runs this on one native runner per platform (on Windows under Git Bash).
#
# Usage: bash search_fetch/build_binary.sh [--out <dir>]
#   Output: <out>/<os>/<arch>/sf, or sf.exe on Windows   (default <out>: <repo>/.tmp/sf/dist)
# Needs: cargo, curl, perl, tar, and a Python with pip (PYTHON, default python3) to build the wheel.
set -euo pipefail

# This folder and the repository root.
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# Output folder.
OUT="$ROOT/.tmp/sf/dist"
if [ "${1:-}" = "--out" ]; then OUT="$2"; fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Work folder for the wheel, the Python distribution and the PyApp source.
WORK="$ROOT/.tmp/sf/build"
mkdir -p "$WORK"
# Pinned PyApp source (release asset digest from the GitHub API). pyapp/Cargo.toml and pyapp/Cargo.lock
# replace the upstream ones: zip 9 and zstd 0.14 instead of 6 and 0.13, and bytes, quinn-proto, rustls,
# tar and time raised to their fixed versions, so cargo audit finds no vulnerability (2026-11-01).
PYAPP_VERSION="0.31.0"
PYAPP_SHA256="16bc883dd936584eef8d0d838feef3e839c340f201f36cc05eb810f29df92c22"
# Pinned Python: the python-build-standalone release PyApp 0.31.0 uses for 3.12; digests from the
# release's SHA256SUMS (2026-11-02).
PBS_RELEASE="20261026"
PBS_PYTHON="3.12.16"
PYTHON="${PYTHON:-python3}"
# Windows (Git Bash): native programs (cargo's build script, python.exe) need C:\ style paths.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
# SHA-256 of a file (the same check on every system).
sha256_of() { "$PYTHON" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$(native_path "$1")"; }

# Target of this machine: rustc's host triple (uname -m reports the shell's CPU, which on Windows on Arm
# can be an emulated x86_64 Git Bash). The triple also names the matching Python build.
host="$(rustc -vV | sed -n 's/^host: //p')"
# Folder names, the executable suffix, the Python digest and the paths inside the distribution.
exe=""
case "$host" in
  x86_64-unknown-linux-gnu) os=linux; arch=amd64; PBS_SHA256="ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20" ;;
  aarch64-unknown-linux-gnu) os=linux; arch=arm64; PBS_SHA256="bb4b6392670c5d3f93876996fcaa19858a4a413a0c7720144c18b0d6f1f0db2d" ;;
  x86_64-apple-darwin) os=macos; arch=amd64; PBS_SHA256="37c38fda76fec1fbf310adcbafb7f0d96af13b5511bf8ea954c3aa8eec185734" ;;
  aarch64-apple-darwin) os=macos; arch=arm64; PBS_SHA256="353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e" ;;
  x86_64-pc-windows-msvc) os=windows; arch=amd64; exe=".exe"; PBS_SHA256="1f2ab53880fc67ea323398c6388e05af28addc99a8e389209f08a51fdff4b149" ;;
  aarch64-pc-windows-msvc) os=windows; arch=arm64; exe=".exe"; PBS_SHA256="3b2e4da9209cec3e0eaf4db31176977a88df32d598ff94a7899c34cd8304db04" ;;
  *) echo "error: unsupported target $host" >&2; exit 1 ;;
esac
if [ "$os" = windows ]; then
  PY_REL="python/python.exe"; SITE_REL="python/Lib/site-packages"
else
  PY_REL="python/bin/python3"; SITE_REL="python/lib/python3.12/site-packages"
fi

# 1. The wheel; dependency pins travel in its metadata.
echo "==> wheel"
rm -rf "$WORK/wheel"
"$PYTHON" -m pip wheel --no-deps -q -w "$WORK/wheel" "$DIR"
WHEEL="$(ls "$WORK"/wheel/search_fetch-*.whl)"

# 2. The Python distribution, checked against the pinned digest.
echo "==> python $PBS_PYTHON ($host)"
PBS_FILE="cpython-$PBS_PYTHON+$PBS_RELEASE-$host-install_only_stripped.tar.gz"
PBS_TAR="$WORK/$PBS_FILE"
if [ ! -f "$PBS_TAR" ]; then
  curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/${PBS_FILE//+/%2B}" -o "$PBS_TAR.part"
  mv "$PBS_TAR.part" "$PBS_TAR"
fi
ACTUAL="$(sha256_of "$PBS_TAR")"
if [ "$ACTUAL" != "$PBS_SHA256" ]; then
  rm -f "$PBS_TAR"
  echo "error: Python SHA256 $ACTUAL does not match $PBS_SHA256" >&2
  exit 1
fi

# 3. search_fetch and its pinned dependencies installed into that Python (from PyPI, at build time only).
echo "==> dependencies"
DIST="$WORK/dist"
rm -rf "$DIST"
mkdir -p "$DIST"
tar -xzf "$PBS_TAR" -C "$DIST"
# Isolated (-I, --isolated): the user's site-packages, PYTHON* / PIP_* variables and pip config of the build
# machine must not satisfy or change a dependency, or the bundle would miss packages.
"$DIST/$PY_REL" -I -m pip install --isolated -q --disable-pip-version-check --no-warn-script-location --prefer-binary "$(native_path "$WHEEL")"
# pip itself is not needed at runtime (nothing is installed there).
"$DIST/$PY_REL" -I -m pip uninstall -q -y pip
# Parts of Python sf never uses: Tcl/Tk and tkinter, IDLE, turtle demos, ensurepip, C headers and import
# libraries, terminfo/man pages, Windows test modules. On Linux the interpreter is linked statically and no
# extension module links libpython, so the 32 MB shared library goes too. The import check below catches
# anything removed by mistake.
STD="$(dirname "$SITE_REL")"
rm -rf "$DIST"/python/{include,share,libs,tcl} "$DIST"/python/lib/{tcl,tk,itcl,thread}[0-9]* "$DIST"/python/lib/lib{tcl,tk}* \
  "$DIST/$STD"/{tkinter,idlelib,turtledemo,ensurepip} "$DIST/$STD"/lib-dynload/_tkinter* \
  "$DIST"/python/DLLs/{_tkinter.pyd,tcl86t.dll,tk86t.dll} "$DIST"/python/DLLs/_test*.pyd
if [ "$os" = linux ]; then rm -f "$DIST"/python/lib/libpython3*.so*; fi
# Every module the CLI uses must import from the bundle (a scratch home keeps the check out of $HOME).
SEARCH_FETCH_HOME="$(native_path "$WORK/check-home")" "$DIST/$PY_REL" -I -c "import search_fetch.cli, search_fetch.fetch, search_fetch.search, search_fetch.ingest, search_fetch.docparse, search_fetch.media, search_fetch.bridge, search_fetch.vendor.crawl4ai.markdown_generator, search_fetch.vendor.crawl4ai.content_filter, pypdf, openpyxl, yt_dlp, idna; from search_fetch.markdown import _html_to_markdown; assert _html_to_markdown('<h1>t</h1><p>body text here</p>', 'https://example.com/')['raw']; print('==> imports ok')"
rm -rf "$WORK/check-home"
# Repacked with the top-level python/ folder, as PyApp's own distributions are.
( cd "$DIST" && tar -czf "$WORK/dist.tar.gz" python )

# 4. PyApp source, checked against the pinned digest.
TARBALL="$WORK/pyapp-v$PYAPP_VERSION.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL "https://github.com/ofek/pyapp/releases/download/v$PYAPP_VERSION/source.tar.gz" -o "$TARBALL.part"
  mv "$TARBALL.part" "$TARBALL"
fi
ACTUAL="$(sha256_of "$TARBALL")"
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

# 5. Two source patches, each checked: the cache folder follows PYAPP_CACHE_DIR (upstream always uses
#    ~/.cache/pyapp), and the install-folder variable uses underscores (PYAPP_INSTALL_DIR_SEARCH_FETCH;
#    PEP 503 turns the project name into search-fetch, and a hyphen cannot be exported in a shell).
perl -0pi -e 's/pub fn cache_dir\(\) -> PathBuf \{\n    platform_dirs\(\)\.cache_dir\(\)\.to_path_buf\(\)\n\}/pub fn cache_dir() -> PathBuf {\n    match env::var("PYAPP_CACHE_DIR") {\n        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),\n        _ => platform_dirs().cache_dir().to_path_buf(),\n    }\n}/s' "$SRC/src/app.rs"
grep -q "PYAPP_CACHE_DIR" "$SRC/src/app.rs" || { echo "error: cache_dir patch did not apply" >&2; exit 1; }
perl -0pi -e 's/"PYAPP_INSTALL_DIR_\{\}",\n        project_name\(\)\.to_uppercase\(\)/"PYAPP_INSTALL_DIR_{}",\n        project_name().to_uppercase().replace('"'"'-'"'"', "_")/s' "$SRC/src/app.rs"
grep -q "replace('-', \"_\")" "$SRC/src/app.rs" || { echo "error: install-dir patch did not apply" >&2; exit 1; }

# 6. Build-time configuration burnt into the binary: the prepared distribution is embedded whole and
#    used as the installation itself (full isolation), and nothing is installed at runtime.
export PYAPP_PROJECT_NAME="search_fetch"
PYAPP_PROJECT_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$DIR/pyproject.toml" | head -n 1)"
export PYAPP_PROJECT_VERSION
export PYAPP_EXEC_MODULE="search_fetch"
export PYAPP_PYTHON_VERSION="3.12"
PYAPP_DISTRIBUTION_PATH="$(native_path "$WORK/dist.tar.gz")"
export PYAPP_DISTRIBUTION_PATH
export PYAPP_DISTRIBUTION_PYTHON_PATH="$PY_REL"
export PYAPP_DISTRIBUTION_SITE_PACKAGES_PATH="$SITE_REL"
export PYAPP_FULL_ISOLATION="1" PYAPP_SKIP_INSTALL="1"
export PYAPP_EXPOSE_PYTHON="1"

# 7. Native build and placement under <os>/<arch>.
echo "==> pyapp"
( cd "$SRC" && cargo build --release --locked --quiet )
mkdir -p "$OUT/$os/$arch"
cp -f "$SRC/target/release/pyapp$exe" "$OUT/$os/$arch/sf$exe"
chmod 0755 "$OUT/$os/$arch/sf$exe"
echo "==> $OUT/$os/$arch/sf$exe ($(du -h "$OUT/$os/$arch/sf$exe" | awk '{print $1}'))"
