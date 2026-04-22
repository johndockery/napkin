#!/usr/bin/env bash
# Build napkind + napkin and stage them where Tauri expects "external
# binaries" so they end up inside the app bundle (on macOS, inside
# Contents/MacOS) next to the napkin app binary.
#
# Tauri's externalBin convention: each path in tauri.conf.json gets a
# platform-triple suffix, e.g. "binaries/napkin" + "aarch64-apple-darwin"
# → `src-tauri/binaries/napkin-aarch64-apple-darwin`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Ensure rustc / cargo are on PATH even when invoked from a fresh shell
# (Tauri's beforeBuildCommand spawns us without the user's interactive
# env). rustup default install path:
if ! command -v rustc >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

# When CARGO_BUILD_TARGET is set (GitHub Actions matrix jobs set this so
# each runner builds for a named triple), cargo writes artifacts to
# target/<triple>/release/ instead of target/release/. Use whatever
# CARGO_BUILD_TARGET says if present; otherwise fall back to the host
# triple, which is correct for local builds.
TARGET_TRIPLE="${CARGO_BUILD_TARGET:-}"
if [[ -z "${TARGET_TRIPLE}" ]]; then
  TARGET_TRIPLE="$(rustc -Vv | awk '/^host:/ {print $2}')"
fi
if [[ -z "${TARGET_TRIPLE}" ]]; then
  echo "bundle-sidecars: could not detect target triple" >&2
  exit 1
fi

if [[ -n "${CARGO_BUILD_TARGET:-}" ]]; then
  OUT_DIR="target/${CARGO_BUILD_TARGET}/release"
else
  OUT_DIR="target/release"
fi

echo "bundle-sidecars: building napkind + napkin-cli for ${TARGET_TRIPLE}"
cargo build --release -p napkind -p napkin-cli

BIN_DIR="src-tauri/binaries"
mkdir -p "${BIN_DIR}"

for bin in napkind napkin; do
  src="${OUT_DIR}/${bin}"
  dst="${BIN_DIR}/${bin}-${TARGET_TRIPLE}"
  if [[ ! -f "${src}" ]]; then
    echo "bundle-sidecars: ${src} missing after build" >&2
    exit 1
  fi
  cp -f "${src}" "${dst}"
  chmod +x "${dst}"
  echo "  → ${dst}"
done
