#!/usr/bin/env sh
# napkin one-shot installer.
#
# Fetches the latest GitHub release asset for the detected platform,
# installs the binaries into ~/.local/bin (napkin + napkind) and, on
# macOS, drops the .app into ~/Applications.
#
#   curl -fsSL https://napkin.world/install | sh
#
# Intentionally POSIX sh so it runs inside minimal containers and
# fresh VMs.

set -eu

REPO="johndockery/napkin"
INSTALL_BIN="${NAPKIN_BIN_DIR:-$HOME/.local/bin}"
INSTALL_APP="${NAPKIN_APP_DIR:-$HOME/Applications}"

fatal() {
  printf 'napkin install: %s\n' "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

detect() {
  # Tauri's bundler names artefacts like `napkin_<ver>_<arch>.<ext>` where
  # <arch> depends on the bundle format: `aarch64`/`x64` for macOS dmg,
  # `amd64` for Linux .deb and .AppImage. Keep those two vocabularies
  # separate so we can compose asset filenames correctly below.
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) dmg_arch="aarch64" ;;
        x86_64) dmg_arch="x64" ;;
        *) fatal "unsupported macOS architecture: $arch" ;;
      esac
      kind="macos"
      ;;
    Linux)
      case "$arch" in
        x86_64) linux_arch="amd64" ;;
        *) fatal "unsupported Linux architecture: $arch (builds available only for x86_64 today)" ;;
      esac
      kind="linux"
      ;;
    *)
      fatal "unsupported OS: $os"
      ;;
  esac
}

fetch_latest_tag() {
  have curl || fatal "curl is required"
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name":' \
    | head -n 1 \
    | sed -E 's/.*"tag_name": ?"([^"]+)".*/\1/'
}

download() {
  url="$1"
  dest="$2"
  printf '  ↓ %s\n' "$url"
  curl -fL --progress-bar -o "$dest" "$url"
}

main() {
  detect
  tag="${NAPKIN_VERSION:-$(fetch_latest_tag)}"
  [ -n "$tag" ] || fatal "could not resolve latest release tag"
  printf 'napkin install: %s (%s/%s)\n' "$tag" "$os" "$arch"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  mkdir -p "$INSTALL_BIN"

  if [ "$kind" = "macos" ]; then
    asset="napkin_${tag#v}_${dmg_arch}.dmg"
    download "https://github.com/$REPO/releases/download/$tag/$asset" "$tmp/napkin.dmg"
    printf '  ↪ mounting dmg\n'
    hdiutil attach -quiet -nobrowse "$tmp/napkin.dmg"
    app_src="$(find /Volumes -maxdepth 3 -name 'napkin.app' -print -quit)"
    [ -n "$app_src" ] || fatal "could not locate napkin.app in dmg"
    mkdir -p "$INSTALL_APP"
    rm -rf "$INSTALL_APP/napkin.app"
    cp -R "$app_src" "$INSTALL_APP/"
    # The release .dmg isn't codesigned or notarized yet. Strip the
    # quarantine xattr so macOS Gatekeeper lets the app open on first
    # launch instead of showing "cannot be verified".
    xattr -dr com.apple.quarantine "$INSTALL_APP/napkin.app" 2>/dev/null || true
    ln -sf "$INSTALL_APP/napkin.app/Contents/MacOS/napkin" "$INSTALL_BIN/napkin"
    ln -sf "$INSTALL_APP/napkin.app/Contents/MacOS/napkind" "$INSTALL_BIN/napkind"
    hdiutil detach -quiet "$(dirname "$app_src")" || true
    printf 'napkin install: installed %s to %s\n' "$tag" "$INSTALL_APP/napkin.app"
    printf '  CLI symlinked into %s\n' "$INSTALL_BIN"
    return
  fi

  # Linux: prefer AppImage on desktops, fall back to .deb
  appimage="napkin_${tag#v}_${linux_arch}.AppImage"
  deb="napkin_${tag#v}_${linux_arch}.deb"

  if have dpkg-deb && have sudo; then
    download "https://github.com/$REPO/releases/download/$tag/$deb" "$tmp/napkin.deb"
    sudo dpkg -i "$tmp/napkin.deb"
    printf 'napkin install: installed %s via dpkg\n' "$tag"
    return
  fi

  download "https://github.com/$REPO/releases/download/$tag/$appimage" "$INSTALL_BIN/napkin.AppImage"
  chmod +x "$INSTALL_BIN/napkin.AppImage"
  ln -sf "$INSTALL_BIN/napkin.AppImage" "$INSTALL_BIN/napkin"
  printf 'napkin install: installed %s AppImage into %s\n' "$tag" "$INSTALL_BIN"
  printf 'add %s to PATH if it is not already there\n' "$INSTALL_BIN"
}

main "$@"
