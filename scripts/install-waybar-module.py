#!/usr/bin/env python3
"""Idempotently install QuickDrop's custom module in a Waybar JSONC config."""

import datetime
import json
import re
import sys
from pathlib import Path

MODULE = "custom/quickdrop"


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def render_module(launcher_path: str) -> str:
    lines = [
        f'  "{MODULE}": {{',
        '    "format": "󰇚",',
        '    "tooltip": true,',
        '    "tooltip-format": "QuickDrop\\nArraste arquivos para enviar",',
        f'    "on-click": {json.dumps(shell_quote(launcher_path))}',
        "  }",
    ]
    return "\n".join(lines)


def find_matching_brace(text: str, open_index: int) -> int:
    depth = 0
    in_string = in_line = in_block = escape = False
    index = open_index
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if in_line:
            if char == "\n":
                in_line = False
        elif in_block:
            if char == "*" and nxt == "/":
                in_block = False
                index += 1
        elif in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        elif char == "/" and nxt == "/":
            in_line = True
            index += 1
        elif char == "/" and nxt == "*":
            in_block = True
            index += 1
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("Unbalanced braces in Waybar config.")


def skip_whitespace(text: str, start: int) -> int:
    index = start
    while index < len(text) and text[index].isspace():
        index += 1
    return index


def line_start(text: str, index: int) -> int:
    line_break = text.rfind("\n", 0, index)
    return 0 if line_break == -1 else line_break + 1


def find_module_range(text: str) -> tuple[int, int] | None:
    needle = f'"{MODULE}"'
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
        return line_start(text, key_index), find_matching_brace(text, cursor) + 1
    return None


def ensure_in_modules_right(text: str) -> str:
    pattern = re.compile(r'("modules-right"\s*:\s*\[)([\s\S]*?)(\n?\s*\])')
    match = pattern.search(text)
    if not match:
        return text

    prefix, body, suffix = match.group(1), match.group(2), match.group(3)
    if f'"{MODULE}"' in body:
        return text

    if "\n" in body:
        indent_match = re.search(r'\n(\s*)"', body)
        item_indent = indent_match.group(1) if indent_match else "    "
        comma = "," if body.strip() else ""
        replacement = f'{prefix}\n{item_indent}"{MODULE}"{comma}{body}{suffix}'
    else:
        separator = ", " if body.strip() else ""
        replacement = f'{prefix}"{MODULE}"{separator}{body}{suffix}'

    return text[: match.start()] + replacement + text[match.end() :]


def insert_module_definition(text: str, block: str) -> str:
    tray_match = re.search(r'\n\s*"tray"\s*:', text)
    if tray_match:
        insert_at = tray_match.start() + 1
        return f"{text[:insert_at]}{block},\n{text[insert_at:]}"

    object_start = text.find("{")
    if object_start == -1:
        raise ValueError("Waybar config must be a JSON object.")

    object_end = find_matching_brace(text, object_start)
    before = text[:object_end].rstrip()
    after = text[object_end:]
    needs_comma = re.search(r"[{,]\s*$", before) is None
    return f"{before}{',' if needs_comma else ''}\n{block}\n{after}"


def upsert_module(text: str, launcher_path: str) -> str:
    block = render_module(launcher_path)
    module_range = find_module_range(text)
    if module_range:
        return text[: module_range[0]] + block + text[module_range[1] :]
    return insert_module_definition(text, block)


def patch(text: str, launcher_path: str) -> str:
    return upsert_module(ensure_in_modules_right(text), launcher_path)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: install-waybar-module.py <config-path> <launcher-path>")

    config_path = Path(sys.argv[1])
    launcher_path = sys.argv[2]
    original = config_path.read_text(encoding="utf-8")
    patched = patch(original, launcher_path)
    if patched == original:
        print("unchanged")
        return

    timestamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d%H%M%S")
    backup_path = Path(f"{config_path}.bak.quickdrop.{timestamp}")
    backup_path.write_text(original, encoding="utf-8")
    config_path.write_text(patched, encoding="utf-8")
    print("changed")
    print(backup_path)


if __name__ == "__main__":
    main()
