#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
MACHINE="$(uname -m)"

case "$PLATFORM" in
  darwin) PLATFORM_DIR="darwin" ;;
  linux) PLATFORM_DIR="linux" ;;
  *)
    echo "Untrunc preparation is supported by this script on macOS and Linux only." >&2
    exit 1
    ;;
esac

case "$MACHINE" in
  x86_64|amd64) ARCH_DIR="x64" ;;
  arm64|aarch64) ARCH_DIR="arm64" ;;
  *)
    echo "Unsupported Untrunc architecture: $MACHINE" >&2
    exit 1
    ;;
esac

TARGET_DIR="$PROJECT_DIR/vendor/untrunc/${PLATFORM_DIR}-${ARCH_DIR}"
TARGET_PATH="$TARGET_DIR/untrunc"
LEGACY_PATH="$PROJECT_DIR/vendor/untrunc-macos/untrunc"

if [ -x "$TARGET_PATH" ]; then
  echo "Bundled Untrunc already exists at $TARGET_PATH"
  exit 0
fi

mkdir -p "$TARGET_DIR"
if [ "$PLATFORM_DIR" = "darwin" ] && [ -x "$LEGACY_PATH" ]; then
  cp "$LEGACY_PATH" "$TARGET_PATH"
  chmod 755 "$TARGET_PATH"
  echo "Staged the existing macOS Untrunc helper at $TARGET_PATH"
  exit 0
fi

for command in git make; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to build Untrunc." >&2
    exit 1
  fi
done

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/media-toolbox-untrunc.XXXXXX")"
SOURCE_DIR="$BUILD_DIR/untrunc"
trap 'rm -rf "$BUILD_DIR"' EXIT

git clone --depth 5 https://github.com/anthwlock/untrunc "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout "${UNTRUNC_SOURCE_REF:-9d86ec9ef2ffed1bf8131abe80742c0574db52b6}"

# FFmpeg 3.3.9's architecture-specific code is rejected by current Linux and
# macOS toolchains. Untrunc still builds and works with FFmpeg's C
# implementations, so disable the optional assembly on both platforms. The
# macOS compatibility flag mirrors the upstream Untrunc Makefile and prevents
# newer Clang versions from treating its legacy function-pointer assignments
# as fatal errors.
FF_CONFIG_FLAGS="--disable-doc --disable-everything --enable-decoders --disable-vdpau --enable-demuxers --enable-protocol=file --disable-avdevice --disable-swresample --disable-swscale --disable-avfilter --disable-xlib --disable-vaapi --disable-zlib --disable-bzlib --disable-lzma --disable-audiotoolbox --disable-videotoolbox --disable-vda --disable-postproc"
FF_CONFIG_FLAGS="$FF_CONFIG_FLAGS --disable-asm"
if [ "$PLATFORM_DIR" = "darwin" ]; then
  FF_CONFIG_FLAGS="$FF_CONFIG_FLAGS --extra-cflags=-Wno-error=incompatible-function-pointer-types"
fi
make -C "$SOURCE_DIR" FF_VER=3.3.9 FF_CONFIG_FLAGS="$FF_CONFIG_FLAGS"
cp "$SOURCE_DIR/untrunc" "$TARGET_PATH"
chmod 755 "$TARGET_PATH"
if [ -f "$SOURCE_DIR/COPYING" ]; then
  cp "$SOURCE_DIR/COPYING" "$PROJECT_DIR/vendor/untrunc/UNTRUNC-COPYING"
fi
echo "Built bundled Untrunc at $TARGET_PATH"
