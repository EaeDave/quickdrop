#!/usr/bin/env bash
# QuickDrop Linux installer for Hyprland with OmarchyBar or Waybar.
#
#   curl -fsSL https://your-quickdrop.example/install.sh | bash
#
# Installs and updates the prebuilt desktop client, the qd CLI/TUI, a
# bar-independent Hyprland launcher, and the detected OmarchyBar/Waybar integration.
set -euo pipefail

APP_NAME="QuickDrop"
DEFAULT_BASE_URL="__QUICKDROP_PUBLIC_BASE_URL__"
MIN_BINARY_BYTES=1048576

base_url="${QUICKDROP_API_BASE_URL:-${QUICKDROP_PUBLIC_BASE_URL:-$DEFAULT_BASE_URL}}"
base_url="${base_url%/}"
installer_url="${QUICKDROP_LINUX_INSTALLER_URL:-$base_url/linux/latest}"
qd_url="${QUICKDROP_QD_URL:-$base_url/linux/qd/latest}"
qd_checksum_url="${QUICKDROP_QD_CHECKSUM_URL:-$base_url/linux/qd/latest.sha256}"
launcher_url="${QUICKDROP_LAUNCHER_URL:-${QUICKDROP_WAYBAR_LAUNCHER_URL:-$base_url/linux/quickdrop-launcher}}"
bar_installer_url="${QUICKDROP_BAR_INSTALLER_URL:-$base_url/linux/install-bar-integration}"
waybar_patcher_url="${QUICKDROP_WAYBAR_PATCHER_URL:-$base_url/linux/install-waybar-module.py}"
omarchy_manifest_url="${QUICKDROP_OMARCHY_MANIFEST_URL:-$base_url/linux/omarchy/manifest.json}"
omarchy_widget_url="${QUICKDROP_OMARCHY_WIDGET_URL:-$base_url/linux/omarchy/BarWidget.qml}"

bin_dir="${QUICKDROP_BIN_DIR:-$HOME/.local/bin}"
share_dir="${QUICKDROP_SHARE_DIR:-$HOME/.local/share/quickdrop}"
config_dir="${QUICKDROP_CONFIG_DIR:-$HOME/.config/quickdrop}"
binary_path="$bin_dir/quickdrop"
qd_path="$bin_dir/qd"
launcher_path="$bin_dir/quickdrop-launcher"
legacy_launcher_path="$bin_dir/quickdrop-waybar"
bar_installer_path="$share_dir/install-bar-integration.sh"
waybar_patcher_path="$share_dir/install-waybar-module.py"
omarchy_plugin_source="$share_dir/omarchy-quickdrop"
config_path="$config_dir/config.env"

# Offline/local-development overrides.
local_binary="${QUICKDROP_LINUX_BINARY:-}"
local_qd="${QUICKDROP_QD_BINARY:-}"
local_launcher="${QUICKDROP_LAUNCHER_FILE:-${QUICKDROP_WAYBAR_LAUNCHER_FILE:-}}"
local_bar_installer="${QUICKDROP_BAR_INTEGRATION_FILE:-}"
local_waybar_patcher="${QUICKDROP_WAYBAR_PATCHER_FILE:-}"
local_omarchy_plugin="${QUICKDROP_OMARCHY_PLUGIN_SOURCE:-}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "${tmp_dir:-}" && -d "${tmp_dir:-}" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found in PATH."
}

ensure_tmp_dir() {
  if [[ -z "${tmp_dir:-}" ]]; then
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quickdrop-install-XXXXXX")"
  fi
}

detect_environment() {
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer only supports Linux. Use install.ps1 on Windows."

  local arch
  arch="$(uname -m)"
  [[ "$arch" == "x86_64" ]] || fail "Only x86_64 is supported by the prebuilt binary (detected: $arch)."

  if [[ -z "$local_binary" || -z "$local_qd" || -z "$local_launcher" || -z "$local_bar_installer" || -z "$local_waybar_patcher" || -z "$local_omarchy_plugin" ]]; then
    require_command curl
  fi
  if [[ -z "$local_qd" ]]; then
    require_command sha256sum
  fi

  if command -v hyprctl >/dev/null 2>&1 || [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]]; then
    info "Detected Hyprland."
  else
    warn "Hyprland was not detected. The client installs, but cursor-aware placement requires hyprctl."
  fi

  check_runtime_deps
}

check_runtime_deps() {
  local missing=()
  local cmd
  for cmd in wl-copy wl-paste notify-send; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done

  if (( ${#missing[@]} > 0 )); then
    warn "Missing runtime tools: ${missing[*]}."
    warn "QuickDrop needs wl-clipboard and libnotify for clipboard + notifications."
    warn "It also needs webkit2gtk and gtk3. On Arch/Omarchy: sudo pacman -S --needed webkit2gtk-4.1 gtk3 wl-clipboard libnotify"
  fi
}

install_local_or_remote() {
  local local_source="$1" url="$2" target="$3" mode="$4" label="$5"
  mkdir -p "$(dirname "$target")"

  if [[ -n "$local_source" ]]; then
    [[ -f "$local_source" ]] || fail "$label does not exist: $local_source"
    install -m "$mode" "$local_source" "$target"
    return
  fi

  ensure_tmp_dir
  local download_path="$tmp_dir/$(basename "$target").$RANDOM"
  info "Downloading $label from $url"
  curl -fSL "$url" -o "$download_path" || fail "Failed to download $label from $url"
  install -m "$mode" "$download_path" "$target"
}

install_binary() {
  mkdir -p "$bin_dir"

  if [[ -n "$local_binary" ]]; then
    [[ -f "$local_binary" ]] || fail "QUICKDROP_LINUX_BINARY does not exist: $local_binary"
    info "Installing QuickDrop binary from $local_binary"
    install -m 0755 "$local_binary" "$binary_path"
    return
  fi

  ensure_tmp_dir
  local download_path="$tmp_dir/quickdrop"
  info "Downloading QuickDrop from $installer_url"
  curl -fSL "$installer_url" -o "$download_path" || fail "Failed to download the QuickDrop binary from $installer_url"

  local size
  size="$(wc -c < "$download_path")"
  [[ "$size" -ge "$MIN_BINARY_BYTES" ]] || fail "Downloaded binary is unexpectedly small: $size bytes. The release asset may be missing."

  install -m 0755 "$download_path" "$binary_path"
  info "Installed binary to $binary_path"
}

install_qd() {
  ensure_tmp_dir
  local download_path="$tmp_dir/qd"

  if [[ -n "$local_qd" ]]; then
    [[ -f "$local_qd" ]] || fail "QUICKDROP_QD_BINARY does not exist: $local_qd"
    info "Installing qd from $local_qd"
    install -m 0755 "$local_qd" "$qd_path"
    return
  fi

  local checksum_path="$tmp_dir/qd.sha256"
  info "Downloading qd from $qd_url"
  curl -fSL "$qd_url" -o "$download_path" || fail "Failed to download qd from $qd_url"
  curl -fSL "$qd_checksum_url" -o "$checksum_path" || fail "Failed to download the qd checksum from $qd_checksum_url"

  local size expected_checksum
  size="$(wc -c < "$download_path")"
  [[ "$size" -ge "$MIN_BINARY_BYTES" ]] || fail "Downloaded qd binary is unexpectedly small: $size bytes. The release asset may be missing."
  expected_checksum="$(cut -d ' ' -f 1 < "$checksum_path")"
  [[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || fail "The qd checksum manifest is invalid."
  printf '%s  %s\n' "$expected_checksum" "$download_path" | sha256sum -c - >/dev/null ||
    fail "qd checksum verification failed. The downloaded binary was not installed."

  install -m 0755 "$download_path" "$qd_path"
  info "Installed qd to $qd_path"
}

install_integration_assets() {
  install_local_or_remote "$local_launcher" "$launcher_url" "$launcher_path" 0755 "QuickDrop launcher"
  # Keep the historical name working for existing Waybar configs.
  install -m 0755 "$launcher_path" "$legacy_launcher_path"

  install_local_or_remote "$local_bar_installer" "$bar_installer_url" "$bar_installer_path" 0755 "bar integration installer"
  install_local_or_remote "$local_waybar_patcher" "$waybar_patcher_url" "$waybar_patcher_path" 0755 "Waybar integration"

  mkdir -p "$omarchy_plugin_source"
  if [[ -n "$local_omarchy_plugin" ]]; then
    [[ -f "$local_omarchy_plugin/manifest.json" && -f "$local_omarchy_plugin/BarWidget.qml" ]] ||
      fail "QUICKDROP_OMARCHY_PLUGIN_SOURCE is not a valid plugin directory: $local_omarchy_plugin"
    install -m 0644 "$local_omarchy_plugin/manifest.json" "$omarchy_plugin_source/manifest.json"
    install -m 0644 "$local_omarchy_plugin/BarWidget.qml" "$omarchy_plugin_source/BarWidget.qml"
  else
    install_local_or_remote "" "$omarchy_manifest_url" "$omarchy_plugin_source/manifest.json" 0644 "OmarchyBar manifest"
    install_local_or_remote "" "$omarchy_widget_url" "$omarchy_plugin_source/BarWidget.qml" 0644 "OmarchyBar widget"
  fi

  info "Installed launcher to $launcher_path"
}

read_config_api_base_url() {
  [[ -f "$config_path" ]] || return 0
  sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?QUICKDROP_API_BASE_URL=//p' "$config_path" |
    tail -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

write_config() {
  local configured_base_url effective_base_url="$base_url"
  if [[ -z "${QUICKDROP_API_BASE_URL:-}" && -z "${QUICKDROP_PUBLIC_BASE_URL:-}" ]]; then
    configured_base_url="$(read_config_api_base_url)"
    [[ -z "$configured_base_url" ]] || effective_base_url="${configured_base_url%/}"
  fi

  mkdir -p "$config_dir"
  printf 'QUICKDROP_API_BASE_URL=%q\n' "$effective_base_url" > "$config_path"
  chmod 0600 "$config_path"
  info "Saved QuickDrop configuration to $config_path"
}

install_bar_integration() {
  QUICKDROP_LAUNCHER_PATH="$launcher_path" \
  QUICKDROP_WAYBAR_PATCHER="$waybar_patcher_path" \
  QUICKDROP_OMARCHY_PLUGIN_SOURCE="$omarchy_plugin_source" \
    bash "$bar_installer_path"
}

main() {
  info "Installing $APP_NAME for Linux (Hyprland + OmarchyBar/Waybar)"
  if [[ "${QUICKDROP_INTEGRATION_ONLY:-0}" != "1" ]]; then
    detect_environment
    install_binary
    install_qd
  fi
  install_integration_assets
  [[ "${QUICKDROP_INTEGRATION_ONLY:-0}" == "1" ]] || write_config
  install_bar_integration

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on your PATH. Add it so 'quickdrop' and 'qd' are runnable from a shell." ;;
  esac

  info "Done. Use the bar icon or run $launcher_path for the desktop client; run qd for the terminal UI."
}

main "$@"
