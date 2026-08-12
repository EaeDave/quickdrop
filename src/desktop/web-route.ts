import { isTauri } from "./tauri";

function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase();
}

export function textRoomPath(code: string): string {
  return `/t/${encodeURIComponent(normalizeRoomCode(code))}`;
}

export function roomCodeFromPathname(pathname: string): string | null {
  const segment = pathname.split("/")[2] ?? "";
  if (!segment) {
    return null;
  }

  try {
    return normalizeRoomCode(decodeURIComponent(segment)) || null;
  } catch {
    return normalizeRoomCode(segment) || null;
  }
}

export function isTextRoute(): boolean {
  if (isTauri) {
    return false;
  }

  const url = new URL(window.location.href);
  return url.hostname.startsWith("texto.") || url.pathname === "/t" || url.pathname.startsWith("/t/") || url.searchParams.has("c");
}

export function initialRoomCode(): string | null {
  const url = new URL(window.location.href);
  const queryCode = normalizeRoomCode(url.searchParams.get("c") ?? "");
  if (queryCode) {
    return queryCode;
  }

  return roomCodeFromPathname(url.pathname);
}

export function setRoomInUrl(code: string): void {
  const normalized = normalizeRoomCode(code);
  if (!normalized) {
    return;
  }

  const url = new URL(window.location.href);
  url.pathname = textRoomPath(normalized);
  url.search = "";
  url.hash = "";
  history.replaceState(history.state, "", url);
}
