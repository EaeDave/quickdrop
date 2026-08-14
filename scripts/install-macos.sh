#!/usr/bin/env bash
# QuickDrop qd CLI/TUI installer for macOS.
#
#   curl -fsSL https://quickdrop.eaedave.xyz/install-macos.sh | bash
set -euo pipefail

DEFAULT_BASE_URL="https://quickdrop.eaedave.xyz"
MIN_BINARY_BYTES=1048576

base_url="${QUICKDROP_API_BASE_URL:-$DEFAULT_BASE_URL}"
base_url="${base_url%/}"
bin_dir="${QUICKDROP_BIN_DIR:-$HOME/.local/bin}"
qd_path="$bin_dir/qd"
local_qd="${QUICKDROP_QD_BINARY:-}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "${tmp_dir:-}" && -d "${tmp_dir:-}" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer only supports macOS."
case "$(uname -m)" in
  arm64) architecture="aarch64" ;;
  x86_64) architecture="x86_64" ;;
  *) fail "Unsupported macOS architecture: $(uname -m)." ;;
esac

if [[ -z "$local_qd" ]]; then
  command -v curl >/dev/null 2>&1 || fail "Required command 'curl' was not found in PATH."
  command -v shasum >/dev/null 2>&1 || fail "Required command 'shasum' was not found in PATH."
fi

mkdir -p "$bin_dir"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quickdrop-install-XXXXXX")"
download_path="$tmp_dir/qd"

if [[ -n "$local_qd" ]]; then
  [[ -f "$local_qd" ]] || fail "QUICKDROP_QD_BINARY does not exist: $local_qd"
  info "Installing qd from $local_qd"
  install -m 0755 "$local_qd" "$qd_path"
else
  qd_url="${QUICKDROP_QD_URL:-$base_url/macos/qd/$architecture/latest}"
  checksum_url="${QUICKDROP_QD_CHECKSUM_URL:-$base_url/macos/qd/$architecture/latest.sha256}"
  checksum_path="$tmp_dir/qd.sha256"

  info "Downloading qd for macOS $architecture"
  curl -fSL "$qd_url" -o "$download_path" || fail "Failed to download qd from $qd_url"
  curl -fSL "$checksum_url" -o "$checksum_path" || fail "Failed to download qd checksum from $checksum_url"

  size="$(wc -c < "$download_path")"
  [[ "$size" -ge "$MIN_BINARY_BYTES" ]] || fail "Downloaded qd binary is unexpectedly small: $size bytes."
  expected_checksum="$(awk 'NF { print $1; exit }' "$checksum_path")"
  [[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || fail "The qd checksum manifest is invalid."
  actual_checksum="$(shasum -a 256 "$download_path" | awk '{ print $1 }')"
  [[ "$actual_checksum" == "$expected_checksum" ]] || fail "qd checksum verification failed."

  install -m 0755 "$download_path" "$qd_path"
fi

info "Installed qd CLI/TUI to $qd_path"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) warn "$bin_dir is not on PATH. Add 'export PATH=\"$bin_dir:\$PATH\"' to ~/.zshrc." ;;
esac
info "Run qd to start the terminal UI."
