import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { zip } from "fflate";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadProgress = { sentBytes: number; totalBytes: number; percent: number };
export type UploadInput = string | File;

export const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

let progressListeners: ((progress: UploadProgress) => void)[] = [];

export function emitWebProgress(percent: number) {
  for (const listener of progressListeners) {
    listener({ sentBytes: 0, totalBytes: 0, percent });
  }
}

export async function uploadFiles(inputs: UploadInput[]): Promise<UploadResponse> {
  if (isTauri) {
    const paths = inputs.filter((i): i is string => typeof i === "string");
    return invoke<UploadResponse>("upload_files", { paths });
  }

  const files = inputs.filter((i): i is File => i instanceof File);
  if (files.length === 0) {
    throw new Error("Nenhum arquivo selecionado.");
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

    uploadFile = new File([zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength) as ArrayBuffer], `quickdrop-${files.length}-arquivos.zip`, {
      type: "application/zip",
    });
  }

  return new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

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
          reject(new Error("Resposta inválida do servidor."));
        }
      } else {
        reject(new Error(xhr.responseText || `Erro no upload: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Falha na conexão com o servidor."));
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

export async function selectLocalFiles(): Promise<string[]> {
  const selection = await open({ title: "Selecionar arquivos", multiple: true, directory: false });

  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

export function copyLink(link: string): Promise<void> {
  if (isTauri) {
    return invoke("copy_link", { link });
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(link);
  }

  return Promise.reject(new Error("Clipboard API não disponível"));
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
