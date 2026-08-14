import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { zip } from "fflate";
import { textRoomPath } from "./web-route";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadProgress = { sentBytes: number; totalBytes: number; percent: number };
export type LocalUploadInput = { path: string; name?: string; temporary?: boolean };
export type UploadInput = string | File | LocalUploadInput;

export const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

let progressListeners: ((progress: UploadProgress) => void)[] = [];
let updateCheckPromise: Promise<void> | null = null;
let interactiveUpdateCheckQueued = false;

export const DESKTOP_UPDATE_EVENT = "quickdrop://check-for-updates";

export function setupDesktopUpdater(): () => void {
  if (!isTauri) {
    return () => {};
  }

  const timer = window.setTimeout(() => {
    void checkForDesktopUpdate(false);
  }, 3_000);
  const unlistenPromise = listen(DESKTOP_UPDATE_EVENT, () => checkForDesktopUpdate(true));

  return () => {
    window.clearTimeout(timer);
    void unlistenPromise.then((unlisten) => unlisten());
  };
}

async function checkForDesktopUpdate(interactive: boolean): Promise<void> {
  if (updateCheckPromise) {
    if (!interactive || interactiveUpdateCheckQueued) {
      return updateCheckPromise;
    }

    interactiveUpdateCheckQueued = true;
    try {
      await updateCheckPromise;
    } finally {
      interactiveUpdateCheckQueued = false;
    }
    return checkForDesktopUpdate(true);
  }

  updateCheckPromise = performDesktopUpdateCheck(interactive).finally(() => {
    updateCheckPromise = null;
  });
  return updateCheckPromise;
}

async function performDesktopUpdateCheck(interactive: boolean): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (interactive) {
        await message("You are already using the latest QuickDrop version.", {
          title: "QuickDrop",
          kind: "info",
        });
      }
      return;
    }

    const accepted = await confirm(
      `QuickDrop ${update.version} is available. Update and restart now?`,
      {
        title: "QuickDrop update",
        kind: "info",
        okLabel: "Update and restart",
        cancelLabel: "Later",
      },
    );
    if (!accepted) {
      return;
    }

    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    console.error("Failed to update QuickDrop", error);
    if (interactive) {
      await message(`Could not check for or install the update: ${formatTauriError(error)}`, {
        title: "QuickDrop update",
        kind: "error",
      });
    }
  }
}

function formatTauriError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function emitWebProgress(percent: number) {
  for (const listener of progressListeners) {
    listener({ sentBytes: 0, totalBytes: 0, percent });
  }
}

export async function uploadFiles(inputs: UploadInput[]): Promise<UploadResponse> {
  const localInputs = inputs.filter(isLocalUploadInput);

  if (isTauri && localInputs.length === inputs.length && localInputs.length > 0) {
    const paths = localInputs.map(localPathOf);
    const cleanupPaths = localInputs.filter(isTemporaryLocalUploadInput).map((input) => input.path);
    return invoke<UploadResponse>("upload_files", { paths, cleanupPaths });
  }

  const files = inputs.filter((i): i is File => i instanceof File);
  if (files.length === 0) {
    throw new Error("No files selected.");
  }

  let uploadFile: File;

  if (files.length === 1) {
    uploadFile = files[0]!;
  } else {
    const zipData: Record<string, Uint8Array> = {};
    const archiveNames = new Map<string, number>();

    for (const file of files) {
      const uniqueName = getUniqueArchiveName(file.name, archiveNames);
      const arrayBuffer = await file.arrayBuffer();
      zipData[uniqueName] = new Uint8Array(arrayBuffer);
    }

    const zipBuffer = await new Promise<Uint8Array>((resolve, reject) => {
      zip(zipData, (err, data) => {
        if (err) reject(err);
        else resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
    });

    uploadFile = new File([zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength) as ArrayBuffer], `quickdrop-${files.length}-files.zip`, {
      type: "application/zip",
    });
  }

  return new Promise<UploadResponse>(async (resolve, reject) => {
    const apiBaseUrl = isTauri ? await invoke<string>("get_api_base_url") : "";
    const uploadUrl = apiBaseUrl ? `${apiBaseUrl}/api/upload` : "/api/upload";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        emitWebProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText) as UploadResponse;
          resolve(res);
        } catch (e) {
          reject(new Error("Invalid server response."));
        }
      } else {
        reject(new Error(xhr.responseText || `Upload error: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Server connection failed."));
    };

    const formData = new FormData();
    formData.append("file", uploadFile);
    xhr.setRequestHeader("x-quickdrop-file-size", uploadFile.size.toString());
    xhr.send(formData);
  });
}

function getUniqueArchiveName(fileName: string, archiveNames: Map<string, number>): string {
  const currentCount = archiveNames.get(fileName) || 0;
  const newCount = currentCount + 1;
  archiveNames.set(fileName, newCount);

  if (newCount === 1) {
    return fileName;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot !== -1) {
    const stem = fileName.slice(0, lastDot);
    const ext = fileName.slice(lastDot);
    return `${stem}-${newCount}${ext}`;
  }

  return `${fileName}-${newCount}`;
}

function isLocalUploadInput(input: UploadInput): input is string | LocalUploadInput {
  return typeof input === "string" || isLocalUploadObject(input);
}

function isLocalUploadObject(input: UploadInput): input is LocalUploadInput {
  return typeof input === "object" && input !== null && !(input instanceof File) && typeof (input as { path?: unknown }).path === "string";
}

function isTemporaryLocalUploadInput(input: string | LocalUploadInput): input is LocalUploadInput {
  return typeof input !== "string" && input.temporary === true;
}

function localPathOf(input: string | LocalUploadInput): string {
  return typeof input === "string" ? input : input.path;
}

export async function getApiBaseUrl(): Promise<string> {
  if (!isTauri) {
    return window.location.origin;
  }
  return invoke<string>("get_api_base_url");
}

export async function readClipboardText(): Promise<string> {
  if (!isTauri) {
    return navigator.clipboard?.readText?.() ?? "";
  }
  return invoke<string>("read_clipboard_text");
}

export async function notifyTextDrop(code: string): Promise<void> {
  if (isTauri) {
    await invoke("notify_text_drop", { code });
  }
}

export async function openTextClipboard(code: string): Promise<void> {
  if (isTauri) {
    await invoke("open_text_clipboard", { code });
    return;
  }
  window.open(textRoomPath(code), "_blank", "noopener,noreferrer");
}

export async function readClipboardUploadInputs(): Promise<LocalUploadInput[]> {
  if (!isTauri) {
    return [];
  }

  return invoke<LocalUploadInput[]>("read_clipboard_upload_inputs");
}

export async function usesNativeClipboardPaste(): Promise<boolean> {
  if (!isTauri) {
    return false;
  }

  return invoke<boolean>("uses_native_clipboard_paste");
}


export async function selectLocalFiles(): Promise<string[]> {
  const selection = await open({ title: "Select files", multiple: true, directory: false });

  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

export function dismissWindow(): Promise<void> {
  if (isTauri) {
    return invoke("dismiss_window");
  }

  return Promise.resolve();
}

export function copyText(text: string): Promise<void> {
  if (isTauri) {
    return invoke("copy_link", { link: text });
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }

  return Promise.reject(new Error("Clipboard API is unavailable"));
}

export function copyLink(link: string): Promise<void> {
  return copyText(link);
}

export function notifySuccess(fileCount: number): Promise<void> {
  if (isTauri) {
    return invoke("notify_success", { fileCount });
  }
  return Promise.resolve();
}

export function onUploadProgress(handler: (progress: UploadProgress) => void): Promise<() => void> {
  if (isTauri) {
    return listen<UploadProgress>("upload-progress", (event) => {
      handler(event.payload);
    });
  }

  progressListeners.push(handler);
  return Promise.resolve(() => {
    progressListeners = progressListeners.filter((h) => h !== handler);
  });
}
