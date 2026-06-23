import { isTauri } from "./tauri";

function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase();
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

  const pathCode = normalizeRoomCode(url.pathname.split("/")[2] ?? "");
  return pathCode || null;
}

export function setRoomInUrl(code: string): void {
  const normalized = normalizeRoomCode(code);
  if (!normalized) {
    return;
  }

  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("c", normalized);
  history.replaceState(history.state, "", url);
}
