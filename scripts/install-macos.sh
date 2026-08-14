#!/usr/bin/env bash
# QuickDrop desktop and qd CLI/TUI installer for macOS.
#
#   curl -fsSL https://quickdrop.eaedave.xyz/install-macos.sh | bash
set -euo pipefail

DEFAULT_BASE_URL="https://quickdrop.eaedave.xyz"
MIN_BINARY_BYTES=1048576

base_url="${QUICKDROP_API_BASE_URL:-$DEFAULT_BASE_URL}"
base_url="${base_url%/}"
bin_dir="${QUICKDROP_BIN_DIR:-$HOME/.local/bin}"
applications_dir="${QUICKDROP_APPLICATIONS_DIR:-$HOME/Applications}"
qd_path="$bin_dir/qd"
app_path="$applications_dir/QuickDrop.app"
local_qd="${QUICKDROP_QD_BINARY:-}"
local_dmg="${QUICKDROP_MACOS_DMG:-}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

release_app_lock() {
  if [[ "${app_lock_acquired:-0}" == "1" ]]; then
    rmdir "$app_lock_path" >/dev/null 2>&1 || true
    app_lock_acquired=0
  fi
}

acquire_app_lock() {
  local attempt
  app_lock_path="$applications_dir/.quickdrop-install.lock"
  for attempt in {1..300}; do
    if mkdir "$app_lock_path" 2>/dev/null; then
      app_lock_acquired=1
      return
    fi
    sleep 0.1
  done
  fail "Another QuickDrop installation is still in progress."
}

cleanup() {
  release_app_lock
  if [[ -n "${mount_dir:-}" ]] && mount | grep -Fq "on $mount_dir "; then
    hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  fi
  if [[ -n "${tmp_dir:-}" && -d "${tmp_dir:-}" ]]; then
    rm -rf "$tmp_dir"
  fi
  if [[ -n "${staged_app_path:-}" && -e "${staged_app_path:-}" ]]; then
    rm -rf "$staged_app_path"
  fi
}
trap cleanup EXIT

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer only supports macOS."
case "$(uname -m)" in
  arm64) architecture="aarch64" ;;
  x86_64) architecture="x86_64" ;;
  *) fail "Unsupported macOS architecture: $(uname -m)." ;;
esac

if [[ -z "$local_qd" || ( "${QUICKDROP_SKIP_DESKTOP:-0}" != "1" && -z "$local_dmg" ) ]]; then
  command -v curl >/dev/null 2>&1 || fail "Required command 'curl' was not found in PATH."
  command -v shasum >/dev/null 2>&1 || fail "Required command 'shasum' was not found in PATH."
fi
if [[ "${QUICKDROP_SKIP_DESKTOP:-0}" != "1" ]]; then
  command -v hdiutil >/dev/null 2>&1 || fail "Required command 'hdiutil' was not found in PATH."
  command -v ditto >/dev/null 2>&1 || fail "Required command 'ditto' was not found in PATH."
fi

verify_download() {
  local asset_path="$1" checksum_path="$2" label="$3"
  local size expected_checksum actual_checksum
  size="$(wc -c < "$asset_path")"
  [[ "$size" -ge "$MIN_BINARY_BYTES" ]] || fail "Downloaded $label is unexpectedly small: $size bytes."
  expected_checksum="$(awk 'NF { print $1; exit }' "$checksum_path")"
  [[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || fail "The $label checksum manifest is invalid."
  actual_checksum="$(shasum -a 256 "$asset_path" | awk '{ print $1 }')"
  [[ "$actual_checksum" == "$expected_checksum" ]] || fail "$label checksum verification failed."
}

mkdir -p "$bin_dir"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quickdrop-install-XXXXXX")"
qd_download_path="$tmp_dir/qd"

if [[ -n "$local_qd" ]]; then
  [[ -f "$local_qd" ]] || fail "QUICKDROP_QD_BINARY does not exist: $local_qd"
  info "Installing qd from $local_qd"
  install -m 0755 "$local_qd" "$qd_path"
else
  qd_url="${QUICKDROP_QD_URL:-$base_url/macos/qd/$architecture/latest}"
  qd_checksum_url="${QUICKDROP_QD_CHECKSUM_URL:-$base_url/macos/qd/$architecture/latest.sha256}"
  qd_checksum_path="$tmp_dir/qd.sha256"

  info "Downloading qd for macOS $architecture"
  curl -fSL "$qd_url" -o "$qd_download_path" || fail "Failed to download qd from $qd_url"
  curl -fSL "$qd_checksum_url" -o "$qd_checksum_path" || fail "Failed to download qd checksum from $qd_checksum_url"
  verify_download "$qd_download_path" "$qd_checksum_path" "qd"
  install -m 0755 "$qd_download_path" "$qd_path"
fi
info "Installed qd CLI/TUI to $qd_path"

if [[ "${QUICKDROP_SKIP_DESKTOP:-0}" != "1" ]]; then
  dmg_path="$tmp_dir/QuickDrop.dmg"
  if [[ -n "$local_dmg" ]]; then
    [[ -f "$local_dmg" ]] || fail "QUICKDROP_MACOS_DMG does not exist: $local_dmg"
    cp "$local_dmg" "$dmg_path"
  else
    dmg_url="${QUICKDROP_MACOS_DMG_URL:-$base_url/macos/$architecture/latest.dmg}"
    dmg_checksum_url="${QUICKDROP_MACOS_DMG_CHECKSUM_URL:-$base_url/macos/$architecture/latest.dmg.sha256}"
    dmg_checksum_path="$tmp_dir/QuickDrop.dmg.sha256"
    info "Downloading QuickDrop menu bar app for macOS $architecture"
    curl -fSL "$dmg_url" -o "$dmg_path" || fail "Failed to download QuickDrop from $dmg_url"
    curl -fSL "$dmg_checksum_url" -o "$dmg_checksum_path" || fail "Failed to download QuickDrop checksum from $dmg_checksum_url"
    verify_download "$dmg_path" "$dmg_checksum_path" "QuickDrop DMG"
  fi

  mount_dir="$tmp_dir/mount"
  mkdir -p "$mount_dir" "$applications_dir"
  hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -readonly -quiet ||
    fail "Failed to mount the QuickDrop DMG."
  [[ -d "$mount_dir/QuickDrop.app" ]] || fail "QuickDrop.app was not found in the DMG."

  staged_app_path="$applications_dir/.QuickDrop.app.staged.$$"
  backup_app_path="$applications_dir/.QuickDrop.app.backup.$$"
  rm -rf "$staged_app_path" "$backup_app_path"
  ditto "$mount_dir/QuickDrop.app" "$staged_app_path" ||
    fail "Failed to stage the QuickDrop menu bar app. The installed app was not changed."

  acquire_app_lock
  if [[ -e "$app_path" ]]; then
    mv "$app_path" "$backup_app_path" ||
      fail "Failed to prepare the installed QuickDrop app for replacement."
  fi
  if ! mv "$staged_app_path" "$app_path"; then
    if [[ -e "$backup_app_path" ]]; then
      mv "$backup_app_path" "$app_path" ||
        fail "QuickDrop replacement failed and the previous app could not be restored from $backup_app_path."
    fi
    fail "Failed to install QuickDrop. The previous app was restored."
  fi
  rm -rf "$backup_app_path"
  release_app_lock

  hdiutil detach "$mount_dir" -quiet
  mount_dir=""
  info "Installed QuickDrop menu bar app to $app_path"

  if [[ "${QUICKDROP_LAUNCH_AFTER_INSTALL:-1}" == "1" ]]; then
    open "$app_path"
  fi
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) warn "$bin_dir is not on PATH. Add 'export PATH=\"$bin_dir:\$PATH\"' to ~/.zshrc." ;;
esac
info "Use the QuickDrop menu bar icon, or run qd to start the terminal UI."
