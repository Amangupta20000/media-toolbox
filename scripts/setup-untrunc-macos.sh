#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This helper is only for macOS. Use the platform packaging workflow for other systems." >&2
  exit 1
fi

exec bash "$(cd "$(dirname "$0")" && pwd)/prepare-untrunc.sh" "$@"
