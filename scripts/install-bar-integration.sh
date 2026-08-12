#!/usr/bin/env bash
# Detect and install the appropriate QuickDrop status-bar integration.
set -euo pipefail

PLUGIN_ID="quickdrop.bar"
MODULE_NAME="custom/quickdrop"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

home="${HOME:-}"
[[ -n "$home" ]] || fail "HOME is not set."

launcher_path="${QUICKDROP_LAUNCHER_PATH:-${QUICKDROP_WAYBAR_LAUNCHER_PATH:-$home/.local/bin/quickdrop-launcher}}"
waybar_config="${QUICKDROP_WAYBAR_CONFIG:-$home/.config/waybar/config.jsonc}"
waybar_patcher="${QUICKDROP_WAYBAR_PATCHER:-$(dirname "$0")/install-waybar-module.py}"
omarchy_plugin_source="${QUICKDROP_OMARCHY_PLUGIN_SOURCE:-$(dirname "$0")/omarchy-quickdrop}"
omarchy_plugin_dir="${QUICKDROP_OMARCHY_PLUGIN_DIR:-$home/.config/omarchy/plugins/$PLUGIN_ID}"
requested_bar="${QUICKDROP_BAR:-auto}"

omarchy_bar_active() {
  command -v omarchy-shell >/dev/null 2>&1 || return 1

  local plugins
  plugins="$(omarchy-shell shell listPlugins 2>/dev/null)" || return 1

  if command -v python3 >/dev/null 2>&1; then
    PLUGINS_JSON="$plugins" python3 -c '
import json, os
plugins = json.loads(os.environ.get("PLUGINS_JSON", "[]"))
raise SystemExit(0 if any(
    item.get("id") == "omarchy.bar" and item.get("active") is True
    for item in plugins
) else 1)
'
  else
    printf '%s' "$plugins" | grep -Eq '"id":"omarchy\.bar"[^}]*"active":true'
  fi
}

waybar_active() {
  command -v pgrep >/dev/null 2>&1 && pgrep -u "$(id -u)" -x waybar >/dev/null 2>&1
}

omarchy_available() {
  command -v omarchy >/dev/null 2>&1 &&
    command -v omarchy-shell >/dev/null 2>&1 &&
    [[ -f "$home/.config/omarchy/shell.json" ]]
}

waybar_available() {
  [[ -f "$waybar_config" ]]
}

detect_bar() {
  case "$requested_bar" in
    auto) ;;
    omarchy|waybar|both|none) printf '%s\n' "$requested_bar"; return ;;
    *) fail "Invalid QUICKDROP_BAR='$requested_bar'. Use auto, omarchy, waybar, both, or none." ;;
  esac

  local has_omarchy=0 has_waybar=0
  omarchy_bar_active && has_omarchy=1
  waybar_active && has_waybar=1

  if (( has_omarchy && has_waybar )); then
    warn "OmarchyBar and Waybar are both active; selecting OmarchyBar. Use QUICKDROP_BAR=both to install both."
    printf 'omarchy\n'
  elif (( has_omarchy )); then
    printf 'omarchy\n'
  elif (( has_waybar )); then
    printf 'waybar\n'
  elif omarchy_available; then
    printf 'omarchy\n'
  elif waybar_available; then
    printf 'waybar\n'
  else
    printf 'none\n'
  fi
}

install_waybar() {
  if [[ ! -f "$waybar_config" ]]; then
    warn "Waybar config not found at $waybar_config; skipping its module."
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || {
    warn "python3 is required to patch Waybar's JSONC config; skipping its module."
    return 0
  }
  [[ -f "$waybar_patcher" ]] || {
    warn "Waybar integration patcher not found at $waybar_patcher; skipping its module."
    return 0
  }

  local patch_output
  if ! patch_output="$(python3 "$waybar_patcher" "$waybar_config" "$launcher_path" 2>&1)"; then
    warn "Could not patch $waybar_config automatically:"
    warn "$patch_output"
    return 0
  fi

  if [[ "$patch_output" == *skipped* ]]; then
    warn "$patch_output"
    return 0
  fi
  if [[ "$patch_output" == unchanged* ]]; then
    info "Waybar module $MODULE_NAME already present in $waybar_config"
    return 0
  fi

  info "Installed Waybar module $MODULE_NAME in $waybar_config"
  local backup
  backup="$(printf '%s\n' "$patch_output" | sed -n '2p')"
  [[ -z "$backup" ]] || info "Backup written to $backup"

  if [[ "${QUICKDROP_BAR_NO_RESTART:-${QUICKDROP_WAYBAR_NO_RESTART:-0}}" == "1" ]]; then
    return 0
  fi
  if pkill -SIGUSR2 -u "$(id -u)" -x waybar >/dev/null 2>&1; then
    info "Reloaded Waybar via SIGUSR2."
  elif command -v omarchy >/dev/null 2>&1 && omarchy restart waybar >/dev/null 2>&1; then
    info "Waybar restarted."
  else
    warn "Waybar config updated, but automatic reload failed. Restart Waybar to see QuickDrop."
  fi
}

install_omarchy() {
  command -v omarchy >/dev/null 2>&1 || {
    warn "The omarchy command is unavailable; skipping the OmarchyBar plugin."
    return 0
  }
  command -v omarchy-shell >/dev/null 2>&1 || {
    warn "The omarchy-shell command is unavailable; skipping the OmarchyBar plugin."
    return 0
  }
  [[ -f "$omarchy_plugin_source/manifest.json" && -f "$omarchy_plugin_source/BarWidget.qml" ]] || {
    warn "OmarchyBar plugin source not found at $omarchy_plugin_source; skipping it."
    return 0
  }

  # Validate the staged source before touching a previously working installation.
  if ! omarchy plugin validate "$omarchy_plugin_source" >/dev/null; then
    warn "Omarchy rejected the QuickDrop plugin manifest at $omarchy_plugin_source."
    return 0
  fi

  mkdir -p "$(dirname "$omarchy_plugin_dir")"
  local plugin_files=(manifest.json BarWidget.qml)
  local changed=0 file
  for file in "${plugin_files[@]}"; do
    cmp -s "$omarchy_plugin_source/$file" "$omarchy_plugin_dir/$file" || changed=1
  done
  if [[ -d "$omarchy_plugin_dir" ]] && (( changed )); then
    local backup timestamp
    timestamp="$(date -u +%Y%m%d%H%M%S)"
    backup="${omarchy_plugin_dir}.bak.quickdrop.${timestamp}"
    cp -a "$omarchy_plugin_dir" "$backup"
    info "Existing OmarchyBar plugin backed up to $backup"
  fi

  mkdir -p "$omarchy_plugin_dir"
  install -m 0644 "$omarchy_plugin_source/manifest.json" "$omarchy_plugin_dir/manifest.json"
  install -m 0644 "$omarchy_plugin_source/BarWidget.qml" "$omarchy_plugin_dir/BarWidget.qml"

  if ! omarchy-shell shell rescanPlugins >/dev/null 2>&1; then
    warn "QuickDrop's OmarchyBar plugin was installed, but the shell is not running; it will be discovered on the next shell start."
    return 0
  fi
  if ! omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id && $2 == "enabled" { found = 1 } END { exit !found }'; then
    if ! omarchy plugin enable "$PLUGIN_ID" --section right >/dev/null 2>&1; then
      warn "Plugin installed but could not be enabled automatically. Run: omarchy plugin enable $PLUGIN_ID --section right"
      return 0
    fi
  fi

  # Persist a custom bin directory without baking machine-specific paths into QML.
  if ! omarchy bar set "$PLUGIN_ID" launcher "$launcher_path" >/dev/null 2>&1; then
    warn "Could not persist the launcher path. Run: omarchy bar set $PLUGIN_ID launcher $launcher_path"
  fi
  info "Installed OmarchyBar plugin $PLUGIN_ID in $omarchy_plugin_dir"
}

selected_bar="$(detect_bar)"

if [[ "${1:-}" == "--detect" ]]; then
  printf '%s\n' "$selected_bar"
  exit 0
fi

info "Detected bar integration: $selected_bar"
case "$selected_bar" in
  omarchy) install_omarchy ;;
  waybar) install_waybar ;;
  both) install_omarchy; install_waybar ;;
  none) warn "No supported status bar detected; QuickDrop was installed without a bar icon." ;;
esac
