#!/usr/bin/env python3
"""Idempotently install QuickDrop's custom module in a Waybar JSONC config."""

from __future__ import annotations

import datetime
import json
import re
import sys
from pathlib import Path

MODULE = "custom/quickdrop"


def shell_quote(value: str) -> str:
    """Quote one executable path for Waybar's shell command."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


def render_module(launcher_path: str, indent: str = "  ") -> str:
    """Render one custom module definition using the containing object's indent."""
    child_indent = indent + "  "
    lines = [
        f'{indent}"{MODULE}": {{',
        f'{child_indent}"format": "󰇚",',
        f'{child_indent}"tooltip": true,',
        f'{child_indent}"tooltip-format": "QuickDrop\\nDrop files to upload",',
        f'{child_indent}"on-click": {json.dumps(shell_quote(launcher_path))}',
        f"{indent}}}",
    ]
    return "\n".join(lines)


def string_end(text: str, start: int) -> int:
    """Return the exclusive end of a JSON string beginning at start."""
    escape = False
    index = start + 1
    while index < len(text):
        char = text[index]
        if escape:
            escape = False
        elif char == "\\":
            escape = True
        elif char == '"':
            return index + 1
        index += 1
    raise ValueError("Unterminated string in Waybar config.")


def skip_jsonc_trivia(text: str, start: int, limit: int | None = None) -> int:
    """Skip JSONC whitespace and comments and return the next token position."""
    end = len(text) if limit is None else limit
    index = start
    while index < end:
        if text[index].isspace():
            index += 1
        elif text.startswith("//", index):
            newline = text.find("\n", index + 2, end)
            index = end if newline == -1 else newline + 1
        elif text.startswith("/*", index):
            close = text.find("*/", index + 2, end)
            if close == -1:
                raise ValueError("Unterminated block comment in Waybar config.")
            index = close + 2
        else:
            break
    return index


def find_matching_delimiter(text: str, open_index: int, opener: str, closer: str) -> int:
    """Find a matching JSONC delimiter while ignoring strings and comments."""
    depth = 0
    index = open_index
    while index < len(text):
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline == -1 else newline + 1
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            if close == -1:
                raise ValueError("Unterminated block comment in Waybar config.")
            index = close + 2
            continue
        if text[index] == '"':
            index = string_end(text, index)
            continue
        if text[index] == opener:
            depth += 1
        elif text[index] == closer:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError(f"Unbalanced {opener}{closer} delimiters in Waybar config.")


def find_matching_brace(text: str, open_index: int) -> int:
    """Find the closing brace for an object beginning at open_index."""
    return find_matching_delimiter(text, open_index, "{", "}")


def line_start(text: str, index: int) -> int:
    """Return the beginning of the line containing index."""
    line_break = text.rfind("\n", 0, index)
    return 0 if line_break == -1 else line_break + 1


def find_modules_right_arrays(text: str) -> list[tuple[int, int, int]]:
    """Return (containing object, array start, array end) for every modules-right key."""
    objects: list[int] = []
    matches: list[tuple[int, int, int]] = []
    index = 0
    while index < len(text):
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline == -1 else newline + 1
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            if close == -1:
                raise ValueError("Unterminated block comment in Waybar config.")
            index = close + 2
            continue

        char = text[index]
        if char == "{":
            objects.append(index)
            index += 1
            continue
        if char == "}":
            if objects:
                objects.pop()
            index += 1
            continue
        if char != '"':
            index += 1
            continue

        end = string_end(text, index)
        try:
            value = json.loads(text[index:end])
        except json.JSONDecodeError:
            value = ""
        cursor = skip_jsonc_trivia(text, end)
        if value == "modules-right" and objects and cursor < len(text) and text[cursor] == ":":
            cursor = skip_jsonc_trivia(text, cursor + 1)
            if cursor < len(text) and text[cursor] == "[":
                matches.append((objects[-1], cursor, find_matching_delimiter(text, cursor, "[", "]")))
        index = end
    return matches


def module_item_indent(text: str, array_start: int, body: str) -> str:
    """Infer indentation for an item inserted into a modules-right array."""
    match = re.search(r'\n([ \t]*)"', body)
    if match:
        return match.group(1)
    key_line_start = line_start(text, array_start)
    key_indent = re.match(r"[ \t]*", text[key_line_start:array_start]).group(0)
    return key_indent + "  "


def ensure_in_modules_right(text: str) -> tuple[str, bool]:
    """Insert the QuickDrop id into every modules-right array."""
    ranges = find_modules_right_arrays(text)
    if not ranges:
        return text, False

    for _object_start, array_start, array_end in reversed(ranges):
        body = text[array_start + 1 : array_end]
        if f'"{MODULE}"' in body:
            continue
        if "\n" in body:
            indent = module_item_indent(text, array_start, body)
            comma = "," if body.strip() else ""
            insertion = f'\n{indent}"{MODULE}"{comma}'
        else:
            separator = ", " if body.strip() else ""
            insertion = f'"{MODULE}"{separator}'
        text = text[: array_start + 1] + insertion + text[array_start + 1 :]
    return text, True


def object_indent(text: str, object_start: int) -> tuple[str, str]:
    """Return the containing object's and its properties' indentation."""
    start = line_start(text, object_start)
    base = re.match(r"[ \t]*", text[start:object_start]).group(0)
    return base, base + "  "


def find_module_range(text: str, object_start: int, object_end: int) -> tuple[int, int] | None:
    """Find QuickDrop's module definition within one Waybar object."""
    needle = f'"{MODULE}"'
    offset = object_start + 1
    while offset < object_end:
        key_index = text.find(needle, offset, object_end)
        if key_index == -1:
            return None
        cursor = skip_jsonc_trivia(text, key_index + len(needle), object_end)
        if cursor >= object_end or text[cursor] != ":":
            offset = key_index + len(needle)
            continue
        cursor = skip_jsonc_trivia(text, cursor + 1, object_end)
        if cursor >= object_end or text[cursor] != "{":
            offset = key_index + len(needle)
            continue
        return line_start(text, key_index), find_matching_brace(text, cursor) + 1
    return None


def last_significant_end(text: str, start: int, end: int) -> int | None:
    """Return the end of the last non-comment token in a JSONC slice."""
    last: int | None = None
    index = start
    while index < end:
        if text[index].isspace():
            index += 1
        elif text.startswith("//", index):
            newline = text.find("\n", index + 2, end)
            index = end if newline == -1 else newline + 1
        elif text.startswith("/*", index):
            close = text.find("*/", index + 2, end)
            if close == -1:
                raise ValueError("Unterminated block comment in Waybar config.")
            index = close + 2
        elif text[index] == '"':
            index = string_end(text, index)
            last = index
        else:
            last = index + 1
            index += 1
    return last


def upsert_module_in_object(text: str, object_start: int, launcher_path: str) -> str:
    """Insert or replace QuickDrop's definition inside one Waybar object."""
    object_end = find_matching_brace(text, object_start)
    base_indent, property_indent = object_indent(text, object_start)
    block = render_module(launcher_path, property_indent)
    module_range = find_module_range(text, object_start, object_end)
    if module_range:
        return text[: module_range[0]] + block + text[module_range[1] :]

    significant_end = last_significant_end(text, object_start + 1, object_end)
    needs_comma = significant_end is not None and text[significant_end - 1] != ","
    comma_at = object_start + 1 if significant_end is None else significant_end
    trailing = text[comma_at:object_end].rstrip()
    return (
        text[:comma_at]
        + ("," if needs_comma else "")
        + trailing
        + "\n"
        + block
        + "\n"
        + base_indent
        + text[object_end:]
    )


def patch(text: str, launcher_path: str) -> tuple[str, bool]:
    """Patch every configured Waybar object and report whether a target list exists."""
    text, found_modules_right = ensure_in_modules_right(text)
    if not found_modules_right:
        return text, False

    object_starts = sorted({item[0] for item in find_modules_right_arrays(text)}, reverse=True)
    for object_start in object_starts:
        text = upsert_module_in_object(text, object_start, launcher_path)
    return text, True


def main() -> None:
    """Patch the requested config, writing one timestamped backup when changed."""
    if len(sys.argv) != 3:
        raise SystemExit("usage: install-waybar-module.py <config-path> <launcher-path>")

    config_path = Path(sys.argv[1])
    launcher_path = sys.argv[2]
    if not config_path.is_file():
        raise SystemExit(f"config not found: {config_path}")

    original = config_path.read_text(encoding="utf-8")
    patched, found_modules_right = patch(original, launcher_path)
    if not found_modules_right:
        print("skipped")
        print(
            f'warning: no "modules-right" array found; add "{MODULE}" to a bar module list manually.',
            file=sys.stderr,
        )
        return
    if patched == original:
        print("unchanged")
        return

    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
    backup_path = Path(f"{config_path}.bak.quickdrop.{timestamp}")
    backup_path.write_text(original, encoding="utf-8")
    config_path.write_text(patched, encoding="utf-8")
    print("changed")
    print(backup_path)


if __name__ == "__main__":
    main()
