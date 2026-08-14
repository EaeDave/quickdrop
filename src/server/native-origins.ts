export const TAURI_WEBVIEW_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
] as const;

export function isTauriWebviewOrigin(origin: string | undefined): boolean {
  return TAURI_WEBVIEW_ORIGINS.includes(origin as (typeof TAURI_WEBVIEW_ORIGINS)[number]);
}
