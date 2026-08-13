import { isTauri } from "./tauri";

function normalizeRoomCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,16}$/.test(normalized) ? normalized : "";
}

export function textRoomPath(code: string): string {
  return `/${encodeURIComponent(normalizeRoomCode(code))}`;
}

export function roomCodeFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return null;
  }

  try {
    return normalizeRoomCode(decodeURIComponent(segments[0] ?? "")) || null;
  } catch {
    return normalizeRoomCode(segments[0] ?? "") || null;
  }
}

export function isTextRoute(): boolean {
  if (isTauri) {
    return false;
  }

  const url = new URL(window.location.href);
  return url.hostname.startsWith("texto.") || roomCodeFromPathname(url.pathname) !== null || url.searchParams.has("c");
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
