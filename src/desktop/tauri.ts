import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadProgress = { sentBytes: number; totalBytes: number; percent: number };

export function uploadFile(path: string): Promise<UploadResponse> {
  return invoke<UploadResponse>("upload_file", { path });
}

export function copyLink(link: string): Promise<void> {
  return invoke("copy_link", { link });
}

export function notifySuccess(): Promise<void> {
  return invoke("notify_success");
}

export function onUploadProgress(handler: (progress: UploadProgress) => void): Promise<() => void> {
  return listen<UploadProgress>("upload-progress", (event) => {
    handler(event.payload);
  });
}
