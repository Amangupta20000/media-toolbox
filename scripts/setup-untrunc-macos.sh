#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/media-toolbox-untrunc.XXXXXX")"
SOURCE_DIR="$BUILD_DIR/untrunc"

if ! command -v git >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
  echo "Git and make are required to build the local Untrunc helper." >&2
  exit 1
fi

git clone --depth 5 https://github.com/anthwlock/untrunc "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout 9d86ec9ef2ffed1bf8131abe80742c0574db52b6
make -C "$SOURCE_DIR" FF_VER=3.3.9
mkdir -p "$PROJECT_DIR/vendor/untrunc-macos"
cp "$SOURCE_DIR/untrunc" "$PROJECT_DIR/vendor/untrunc-macos/untrunc"
chmod 755 "$PROJECT_DIR/vendor/untrunc-macos/untrunc"
echo "Installed local Untrunc helper at $PROJECT_DIR/vendor/untrunc-macos/untrunc"
