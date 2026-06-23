import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadProgress = { sentBytes: number; totalBytes: number; percent: number };

export function uploadFiles(paths: string[]): Promise<UploadResponse> {
  return invoke<UploadResponse>("upload_files", { paths });
}

export async function selectLocalFiles(): Promise<string[]> {
  const selection = await open({ title: "Selecionar arquivos", multiple: true, directory: false });

  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

export function copyLink(link: string): Promise<void> {
  return invoke("copy_link", { link });
}

export function notifySuccess(fileCount: number): Promise<void> {
  return invoke("notify_success", { fileCount });
}

export function onUploadProgress(handler: (progress: UploadProgress) => void): Promise<() => void> {
  return listen<UploadProgress>("upload-progress", (event) => {
    handler(event.payload);
  });
}
