#!/usr/bin/env bash
#
# Build WriterAgent binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#   --sf-dir <dir>       WriterAgent: search_fetch binaries as <dir>/<os>/<arch>/sf (search_fetch/build_binary.sh);
#                        each Linux and macOS package gets its own as search_fetch/<os>/<arch>/sf
#
# Output:
#   packages/coding-agent/binaries/
#     writeragent-darwin-arm64.tar.gz
#     writeragent-darwin-x64.tar.gz
#     writeragent-linux-x64.tar.gz
#     writeragent-linux-arm64.tar.gz
#     writeragent-windows-x64.zip
#     writeragent-windows-arm64.zip
#   Each package also carries pinned fd and rg (bin/), the built-in writing skills (writer-skills/)
#   and third-party license texts (THIRD_PARTY/).

set -euo pipefail

# WriterAgent: name of the executable and of the release archives.
NAME=writeragent

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""
SF_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --sf-dir)
            SF_DIR="$(cd "$2" && pwd)"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. Bun places them at their path relative to the
    # common directory of all entrypoints, so the main entry must stay in dist/
    # for the worker specifiers in the runtime to resolve.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684). Disable cwd .env autoload so
    # project env files do not leak into pi's environment (see #10473).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/$NAME.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/$NAME"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    # WriterAgent: write a branded package.json (name "writeragent", config dir ~/.writeragent)
    node ../../scripts/writer-brand.mjs package.json "$OUTPUT_DIR/$platform/package.json"
    # WriterAgent: the WriterAgent README in both languages (the upstream pi guide stays in docs/).
    cp ../../README.md ../../README.zh.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    # Copy the selected architecture's native platform helpers next to the executable.
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"

    # WriterAgent: built-in writing skills, one folder per language (getWriterSkillsDir).
    mkdir -p "$OUTPUT_DIR/$platform/writer-skills"
    cp -R skills/writer/zh skills/writer/en "$OUTPUT_DIR/$platform/writer-skills/"
    # WriterAgent: pinned fd and rg with SHA256 checks (bin/), and their licenses.
    node ../../scripts/writer-tools.mjs "$platform" "$OUTPUT_DIR/$platform"
    # WriterAgent: license texts of bundled third-party code.
    mkdir -p "$OUTPUT_DIR/$platform/THIRD_PARTY/unpdf" "$OUTPUT_DIR/$platform/THIRD_PARTY/docx" "$OUTPUT_DIR/$platform/THIRD_PARTY/fflate" "$OUTPUT_DIR/$platform/THIRD_PARTY/unicode"
    cp ../../node_modules/unpdf/LICENSE ../../node_modules/unpdf/dist/licenses/* "$OUTPUT_DIR/$platform/THIRD_PARTY/unpdf/"
    cp ../../node_modules/docx/LICENSE "$OUTPUT_DIR/$platform/THIRD_PARTY/docx/"
    cp ../../node_modules/fflate/LICENSE "$OUTPUT_DIR/$platform/THIRD_PARTY/fflate/"
    cp src/writer/data/UNICODE-LICENSE.txt "$OUTPUT_DIR/$platform/THIRD_PARTY/unicode/"
    # WriterAgent: lieflat-gongwen (PolyForm Noncommercial) covers its skill folder and the gongwen_check port.
    mkdir -p "$OUTPUT_DIR/$platform/THIRD_PARTY/lieflat-gongwen"
    cp skills/writer/zh/lieflat-gongwen/LICENSE "$OUTPUT_DIR/$platform/THIRD_PARTY/lieflat-gongwen/LICENSE"
    # WriterAgent: the Chrome extension (loaded once in chrome://extensions), Readability's license,
    # the Chinese guide with screenshots for this system, and an empty reference folder.
    cp -R ../../search_fetch/src/search_fetch/extension "$OUTPUT_DIR/$platform/chrome-extension"
    mkdir -p "$OUTPUT_DIR/$platform/THIRD_PARTY/readability"
    cp ../../search_fetch/src/search_fetch/extension/vendor/Readability-LICENSE.md "$OUTPUT_DIR/$platform/THIRD_PARTY/readability/LICENSE.md"
    node ../../scripts/writer-guide.mjs "$platform" "$OUTPUT_DIR/$platform/使用说明.html"
    mkdir -p "$OUTPUT_DIR/$platform/参考资料"

    # WriterAgent: the search_fetch binary of this platform (no Windows build), where locateSf looks.
    if [[ -n "$SF_DIR" && "$platform" != windows-* ]]; then
        sf_os="${platform%-*}"; sf_os="${sf_os/darwin/macos}"
        sf_arch="${platform#*-}"; sf_arch="${sf_arch/x64/amd64}"
        if [[ ! -f "$SF_DIR/$sf_os/$sf_arch/sf" ]]; then
            echo "error: missing $SF_DIR/$sf_os/$sf_arch/sf" >&2
            exit 1
        fi
        mkdir -p "$OUTPUT_DIR/$platform/search_fetch/$sf_os/$sf_arch"
        cp "$SF_DIR/$sf_os/$sf_arch/sf" "$OUTPUT_DIR/$platform/search_fetch/$sf_os/$sf_arch/sf"
        chmod 0755 "$OUTPUT_DIR/$platform/search_fetch/$sf_os/$sf_arch/sf"
    fi
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating $NAME-$platform.zip..."
        (cd "$platform" && zip -r ../$NAME-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating $NAME-$platform.tar.gz..."
        mv "$platform" $NAME && tar -czf $NAME-$platform.tar.gz $NAME && mv $NAME "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../$NAME-$platform.zip)
    else
        tar -xzf $NAME-$platform.tar.gz && mv $NAME "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/$NAME.exe"
    else
        echo "  $OUTPUT_DIR/$platform/$NAME"
    fi
done
