export type TextDropContentType = "text" | "url" | "command" | "json";

const COMMAND_PREFIX = /^(?:\$\s+|#!\/|(?:sudo|curl|wget|git|docker|podman|kubectl|helm|ssh|scp|rsync|bun|npm|pnpm|yarn|pip|python|node|deno|cargo|go|make|cmake|systemctl|journalctl|apt|dnf|pacman|brew|powershell|pwsh|cmd)(?:\s|$))/i;

export function classifyTextDrop(content: string): TextDropContentType {
  const trimmed = content.trim();

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return "url";
  }

  if (looksLikeJson(trimmed)) {
    return "json";
  }

  if (COMMAND_PREFIX.test(trimmed)) {
    return "command";
  }

  return "text";
}

function looksLikeJson(value: string): boolean {
  if (!(value.startsWith("{") && value.endsWith("}")) && !(value.startsWith("[") && value.endsWith("]"))) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}
