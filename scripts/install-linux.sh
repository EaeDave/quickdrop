#!/usr/bin/env bash
# QuickDrop Linux installer for Hyprland + Waybar setups.
#
#   curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash
#
# Downloads the prebuilt QuickDrop binary from the latest GitHub release
# (proxied by the server so no token is exposed), installs it together with the
# Waybar launcher, and idempotently registers the "custom/quickdrop" module in
# the user's Waybar config. The Waybar config patch mirrors the behavior of
# scripts/install-waybar-module.ts; it is reimplemented in Python here because
# end-user machines are not expected to have Bun.
set -euo pipefail

APP_NAME="QuickDrop"
MODULE_NAME="custom/quickdrop"
DEFAULT_BASE_URL="https://quickdrop.eaedave.xyz"
MIN_BINARY_BYTES=1048576

base_url="${QUICKDROP_API_BASE_URL:-$DEFAULT_BASE_URL}"
base_url="${base_url%/}"
installer_url="${QUICKDROP_LINUX_INSTALLER_URL:-$base_url/linux/latest}"
launcher_url="${QUICKDROP_WAYBAR_LAUNCHER_URL:-$base_url/linux/quickdrop-waybar}"

bin_dir="${QUICKDROP_BIN_DIR:-$HOME/.local/bin}"
binary_path="$bin_dir/quickdrop"
launcher_path="$bin_dir/quickdrop-waybar"
config_path="${QUICKDROP_WAYBAR_CONFIG:-$HOME/.config/waybar/config.jsonc}"

# Offline/test overrides: use local files instead of downloading.
local_binary="${QUICKDROP_LINUX_BINARY:-}"
local_launcher="${QUICKDROP_WAYBAR_LAUNCHER_FILE:-}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "${tmp_dir:-}" ] && [ -d "${tmp_dir:-}" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

detect_environment() {
  if [ "$(uname -s)" != "Linux" ]; then
    fail "This installer only supports Linux. Use the Windows installer (install.ps1) elsewhere."
  fi

  local arch
  arch="$(uname -m)"
  if [ "$arch" != "x86_64" ]; then
    fail "Only x86_64 is supported by the prebuilt binary (detected: $arch)."
  fi

  require_command curl

  if ! command -v waybar >/dev/null 2>&1; then
    fail "Waybar was not found. QuickDrop's Linux client integrates with Waybar on Hyprland."
  fi

  if command -v hyprctl >/dev/null 2>&1 || [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
    info "Detected Hyprland + Waybar."
  else
    warn "Hyprland was not detected. The Waybar module still installs, but cursor-aware window placement needs Hyprland (hyprctl)."
  fi

  check_runtime_deps
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found in PATH."
}

check_runtime_deps() {
  local missing=()
  local cmd
  for cmd in wl-copy wl-paste notify-send; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    warn "Missing runtime tools: ${missing[*]}."
    warn "QuickDrop needs wl-clipboard (wl-copy/wl-paste) and libnotify (notify-send) for clipboard + notifications."
    warn "It also needs webkit2gtk and gtk3 at runtime. On Arch/Omarchy: sudo pacman -S --needed webkit2gtk-4.1 gtk3 wl-clipboard libnotify"
  fi
}

install_binary() {
  mkdir -p "$bin_dir"

  if [ -n "$local_binary" ]; then
    [ -f "$local_binary" ] || fail "QUICKDROP_LINUX_BINARY does not exist: $local_binary"
    info "Installing QuickDrop binary from $local_binary"
    install -m 0755 "$local_binary" "$binary_path"
    return
  fi

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quickdrop-install-XXXXXX")"
  local download_path="$tmp_dir/quickdrop"

  info "Downloading QuickDrop from $installer_url"
  curl -fSL "$installer_url" -o "$download_path" || fail "Failed to download the QuickDrop binary from $installer_url"

  local size
  size="$(wc -c < "$download_path")"
  if [ "$size" -lt "$MIN_BINARY_BYTES" ]; then
    fail "Downloaded binary is unexpectedly small: $size bytes. The release asset may be missing."
  fi

  install -m 0755 "$download_path" "$binary_path"
  info "Installed binary to $binary_path"
}

install_launcher() {
  mkdir -p "$bin_dir"

  if [ -n "$local_launcher" ]; then
    [ -f "$local_launcher" ] || fail "QUICKDROP_WAYBAR_LAUNCHER_FILE does not exist: $local_launcher"
    install -m 0755 "$local_launcher" "$launcher_path"
  else
    tmp_dir="${tmp_dir:-$(mktemp -d "${TMPDIR:-/tmp}/quickdrop-install-XXXXXX")}"
    local download_path="$tmp_dir/quickdrop-waybar"
    info "Downloading Waybar launcher from $launcher_url"
    curl -fSL "$launcher_url" -o "$download_path" || fail "Failed to download the Waybar launcher from $launcher_url"
    install -m 0755 "$download_path" "$launcher_path"
  fi

  info "Installed Waybar launcher to $launcher_path"
}

patch_waybar_config() {
  if [ ! -f "$config_path" ]; then
    warn "Waybar config not found at $config_path; skipping automatic module install."
    warn "Add \"$MODULE_NAME\" to \"modules-right\" and define the module with on-click:"
    warn "  env QUICKDROP_API_BASE_URL='$base_url' '$launcher_path'"
    return
  fi

  require_command python3

  local patcher
  patcher="$(mktemp "${TMPDIR:-/tmp}/quickdrop-patch-XXXXXX.py")"
  write_patcher "$patcher"

  local patch_output
  if patch_output="$(python3 "$patcher" "$config_path" "$launcher_path" "$base_url" 2>&1)"; then
    rm -f "$patcher"
    case "$patch_output" in
      unchanged*)
        info "Waybar module $MODULE_NAME already present in $config_path"
        ;;
      *)
        info "Installed Waybar module $MODULE_NAME in $config_path"
        local backup
        backup="$(printf '%s\n' "$patch_output" | sed -n '2p')"
        [ -n "$backup" ] && info "Backup written to $backup"
        waybar_changed=1
        ;;
    esac
  else
    rm -f "$patcher"
    warn "Could not patch $config_path automatically:"
    warn "$patch_output"
    warn "Add \"$MODULE_NAME\" to \"modules-right\" manually with on-click:"
    warn "  env QUICKDROP_API_BASE_URL='$base_url' '$launcher_path'"
  fi
}

restart_waybar() {
  [ "${waybar_changed:-0}" = "1" ] || return 0
  [ "${QUICKDROP_WAYBAR_NO_RESTART:-0}" = "1" ] && return 0

  if command -v omarchy >/dev/null 2>&1 && omarchy restart waybar >/dev/null 2>&1; then
    info "Waybar restarted."
  elif pkill -SIGUSR2 waybar >/dev/null 2>&1; then
    info "Reloaded Waybar via SIGUSR2."
  else
    warn "Waybar config updated, but automatic restart failed. Restart Waybar to see the QuickDrop icon."
  fi
}

write_patcher() {
  cat > "$1" <<'PYEOF'
import datetime
import json
import re
import sys

MODULE = "custom/quickdrop"
DEFAULT_API = "https://quickdrop.eaedave.xyz"


def normalize_api(value):
    value = (value or "").strip() or DEFAULT_API
    return re.sub(r"/+$", "", value)


def shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def render_module(launcher_path, api_base_url):
    on_click = "env QUICKDROP_API_BASE_URL=%s %s" % (
        shell_quote(api_base_url),
        shell_quote(launcher_path),
    )
    lines = [
        '  "%s": {' % MODULE,
        '    "format": "󰇚",',
        '    "tooltip": true,',
        '    "tooltip-format": "QuickDrop\\nArraste arquivos para enviar",',
        '    "on-click": %s' % json.dumps(on_click),
        "  }",
    ]
    return "\n".join(lines)


def find_matching_brace(text, open_index):
    depth = 0
    in_string = in_line = in_block = escape = False
    i = open_index
    n = len(text)
    while i < n:
        char = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_line:
            if char == "\n":
                in_line = False
        elif in_block:
            if char == "*" and nxt == "/":
                in_block = False
                i += 1
        elif in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        elif char == "/" and nxt == "/":
            in_line = True
            i += 1
        elif char == "/" and nxt == "*":
            in_block = True
            i += 1
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("Unbalanced braces in Waybar config.")


def skip_whitespace(text, start):
    i = start
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def line_start(text, index):
    line_break = text.rfind("\n", 0, index)
    return 0 if line_break == -1 else line_break + 1


def find_module_range(text):
    needle = '"%s"' % MODULE
    offset = 0
    while offset < len(text):
        key_index = text.find(needle, offset)
        if key_index == -1:
            return None
        cursor = skip_whitespace(text, key_index + len(needle))
        if cursor >= len(text) or text[cursor] != ":":
            offset = key_index + len(needle)
            continue
        cursor = skip_whitespace(text, cursor + 1)
        if cursor >= len(text) or text[cursor] != "{":
            offset = key_index + len(needle)
            continue
        return (line_start(text, key_index), find_matching_brace(text, cursor) + 1)
    return None


def ensure_in_modules_right(text):
    pattern = re.compile(r'("modules-right"\s*:\s*\[)([\s\S]*?)(\n?\s*\])')
    match = pattern.search(text)
    if not match:
        return text

    prefix, body, suffix = match.group(1), match.group(2), match.group(3)
    if ('"%s"' % MODULE) in body:
        return text

    if "\n" in body:
        indent_match = re.search(r'\n(\s*)"', body)
        item_indent = indent_match.group(1) if indent_match else "    "
        comma = "," if body.strip() else ""
        replacement = '%s\n%s"%s"%s%s%s' % (prefix, item_indent, MODULE, comma, body, suffix)
    else:
        separator = ", " if body.strip() else ""
        replacement = '%s"%s"%s%s%s' % (prefix, MODULE, separator, body, suffix)

    return text[: match.start()] + replacement + text[match.end():]


def insert_module_definition(text, block):
    tray_match = re.search(r'\n\s*"tray"\s*:', text)
    if tray_match:
        insert_at = tray_match.start() + 1
        return "%s%s,\n%s" % (text[:insert_at], block, text[insert_at:])

    object_start = text.find("{")
    if object_start == -1:
        raise ValueError("Waybar config must be a JSON object.")

    object_end = find_matching_brace(text, object_start)
    before = text[:object_end].rstrip()
    after = text[object_end:]
    needs_comma = re.search(r"[{,]\s*$", before) is None
    return "%s%s\n%s\n%s" % (before, "," if needs_comma else "", block, after)


def upsert_module(text, launcher_path, api_base_url):
    block = render_module(launcher_path, api_base_url)
    module_range = find_module_range(text)
    if module_range:
        return text[: module_range[0]] + block + text[module_range[1]:]
    return insert_module_definition(text, block)


def patch(text, launcher_path, api_base_url):
    api_base_url = normalize_api(api_base_url)
    text = ensure_in_modules_right(text)
    text = upsert_module(text, launcher_path, api_base_url)
    return text


def main():
    config_path, launcher_path, api_base_url = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(config_path, "r", encoding="utf-8") as handle:
        original = handle.read()

    patched = patch(original, launcher_path, api_base_url)
    if patched == original:
        print("unchanged")
        return

    timestamp = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    backup_path = "%s.bak.quickdrop.%s" % (config_path, timestamp)
    with open(backup_path, "w", encoding="utf-8") as handle:
        handle.write(original)
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write(patched)

    print("changed")
    print(backup_path)


if __name__ == "__main__":
    main()
PYEOF
}

main() {
  info "Installing $APP_NAME for Linux (Hyprland + Waybar)"
  detect_environment
  install_binary
  install_launcher
  patch_waybar_config
  restart_waybar

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on your PATH. Add it so 'quickdrop' is runnable from a shell." ;;
  esac

  info "Done. The QuickDrop icon (󰇚) should appear in Waybar; click it to open the uploader."
}

main "$@"
