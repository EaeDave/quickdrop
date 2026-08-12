#!/usr/bin/env bash
# Install/reapply bar assets from the current checkout without rebuilding Tauri.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

QUICKDROP_INTEGRATION_ONLY=1 \
QUICKDROP_LAUNCHER_FILE="$script_dir/quickdrop-launcher" \
QUICKDROP_BAR_INTEGRATION_FILE="$script_dir/install-bar-integration.sh" \
QUICKDROP_WAYBAR_PATCHER_FILE="$script_dir/install-waybar-module.py" \
QUICKDROP_OMARCHY_PLUGIN_SOURCE="$script_dir/omarchy-quickdrop" \
  bash "$script_dir/install-linux.sh"
