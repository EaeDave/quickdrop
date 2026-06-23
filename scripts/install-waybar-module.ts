import { $ } from "bun";

const QUICKDROP_MODULE = "custom/quickdrop";
const DEFAULT_QUICKDROP_API_BASE_URL = "https://quickdrop.eaedave.xyz";

export type InstallWaybarModuleResult = {
  configPath: string;
  changed: boolean;
  modulePresent: boolean;
  restarted: boolean;
  backupPath?: string;
  reason?: "config_missing" | "home_missing";
};

export type InstallWaybarModuleOptions = {
  home?: string;
  configPath?: string;
  launcherPath?: string;
  apiBaseUrl?: string;
  restart?: boolean;
};

export function patchWaybarConfig(
  input: string,
  launcherPath: string,
  apiBaseUrl = DEFAULT_QUICKDROP_API_BASE_URL,
): { text: string; changed: boolean } {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  let text = ensureQuickdropInModulesRight(input);
  text = upsertQuickdropModule(text, launcherPath, normalizedApiBaseUrl);
  return { text, changed: text !== input };
}

export async function installWaybarModule(
  options: InstallWaybarModuleOptions = {},
): Promise<InstallWaybarModuleResult> {
  const home = options.home ?? process.env.HOME;

  if (!home) {
    console.warn("Skipped Waybar module install: HOME is not set.");
    return { configPath: "", changed: false, modulePresent: false, restarted: false, reason: "home_missing" };
  }

  const configPath = options.configPath ?? process.env.QUICKDROP_WAYBAR_CONFIG ?? `${home}/.config/waybar/config.jsonc`;
  const launcherPath = options.launcherPath ?? `${home}/.local/bin/quickdrop-waybar`;
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? process.env.QUICKDROP_API_BASE_URL);

  if (!(await Bun.file(configPath).exists())) {
    console.warn(`Skipped Waybar module install: ${configPath} not found.`);
    return { configPath, changed: false, modulePresent: false, restarted: false, reason: "config_missing" };
  }

  const original = await Bun.file(configPath).text();
  const { text, changed } = patchWaybarConfig(original, launcherPath, apiBaseUrl);

  if (!changed) {
    console.log(`Waybar module ${QUICKDROP_MODULE} already installed in ${configPath}`);
    return { configPath, changed: false, modulePresent: true, restarted: false };
  }

  const backupPath = `${configPath}.bak.quickdrop.${timestamp()}`;
  await Bun.write(backupPath, original);
  await Bun.write(configPath, text);

  let restarted = false;
  if (options.restart ?? process.env.QUICKDROP_WAYBAR_NO_RESTART !== "1") {
    restarted = await restartWaybar();
  }

  console.log(`Installed Waybar module ${QUICKDROP_MODULE} in ${configPath}`);
  console.log(`Backup written to ${backupPath}`);

  return { configPath, changed: true, modulePresent: true, restarted, backupPath };
}

function renderQuickdropModule(launcherPath: string, apiBaseUrl: string): string {
  const onClick = `env QUICKDROP_API_BASE_URL=${shellQuote(apiBaseUrl)} ${shellQuote(launcherPath)}`;

  return [
    `  "${QUICKDROP_MODULE}": {`,
    `    "format": "󰇚",`,
    `    "tooltip": true,`,
    `    "tooltip-format": "QuickDrop\\nArraste arquivos para enviar",`,
    `    "on-click": ${JSON.stringify(onClick)}`,
    "  }",
  ].join("\n");
}

function normalizeApiBaseUrl(input: string | undefined): string {
  const trimmed = input?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : DEFAULT_QUICKDROP_API_BASE_URL).replace(/\/+$/, "");
}

function shellQuote(input: string): string {
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}

function ensureQuickdropInModulesRight(text: string): string {
  const modulesRightPattern = /("modules-right"\s*:\s*\[)([\s\S]*?)(\n?\s*\])/m;
  const match = modulesRightPattern.exec(text);

  if (!match) {
    return text;
  }

  const prefix = match[1] ?? "";
  const body = match[2] ?? "";
  const suffix = match[3] ?? "";

  if (body.includes(`"${QUICKDROP_MODULE}"`)) {
    return text;
  }

  let replacement: string;
  if (body.includes("\n")) {
    const itemIndent = body.match(/\n(\s*)"/)?.[1] ?? "    ";
    const comma = body.trim().length > 0 ? "," : "";
    replacement = `${prefix}\n${itemIndent}"${QUICKDROP_MODULE}"${comma}${body}${suffix}`;
  } else {
    const separator = body.trim().length > 0 ? ", " : "";
    replacement = `${prefix}"${QUICKDROP_MODULE}"${separator}${body}${suffix}`;
  }

  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

function upsertQuickdropModule(text: string, launcherPath: string, apiBaseUrl: string): string {
  const block = renderQuickdropModule(launcherPath, apiBaseUrl);
  const range = findModuleDefinitionRange(text);

  if (range) {
    return text.slice(0, range.start) + block + text.slice(range.end);
  }

  return insertModuleDefinition(text, block);
}

function findModuleDefinitionRange(text: string): { start: number; end: number } | null {
  const needle = `"${QUICKDROP_MODULE}"`;
  let offset = 0;

  while (offset < text.length) {
    const keyIndex = text.indexOf(needle, offset);
    if (keyIndex === -1) {
      return null;
    }

    let cursor = skipWhitespace(text, keyIndex + needle.length);
    if (text.charAt(cursor) !== ":") {
      offset = keyIndex + needle.length;
      continue;
    }

    cursor = skipWhitespace(text, cursor + 1);
    if (text.charAt(cursor) !== "{") {
      offset = keyIndex + needle.length;
      continue;
    }

    return {
      start: lineStart(text, keyIndex),
      end: findMatchingBrace(text, cursor) + 1,
    };
  }

  return null;
}

function insertModuleDefinition(text: string, block: string): string {
  const trayMatch = /\n\s*"tray"\s*:/.exec(text);
  if (trayMatch) {
    const insertAt = trayMatch.index + 1;
    return `${text.slice(0, insertAt)}${block},\n${text.slice(insertAt)}`;
  }

  const objectStart = text.indexOf("{");
  if (objectStart === -1) {
    throw new Error("Waybar config must be a JSON object.");
  }

  const objectEnd = findMatchingBrace(text, objectStart);
  const before = text.slice(0, objectEnd).replace(/\s*$/, "");
  const after = text.slice(objectEnd);
  const needsComma = !/[{,]\s*$/.test(before);

  return `${before}${needsComma ? "," : ""}\n${block}\n${after}`;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error("Unbalanced braces in Waybar config.");
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/.test(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function lineStart(text: string, index: number): number {
  const lineBreak = text.lastIndexOf("\n", index);
  return lineBreak === -1 ? 0 : lineBreak + 1;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

async function restartWaybar(): Promise<boolean> {
  try {
    await $`omarchy restart waybar`.quiet();
    console.log("Waybar restarted.");
    return true;
  } catch (error) {
    console.warn(`Waybar config updated, but restart failed: ${String(error)}`);
    return false;
  }
}

if (import.meta.main) {
  await installWaybarModule();
}
