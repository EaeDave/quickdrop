import { Zip, ZipDeflate } from "fflate";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadProgress = { sentBytes: number; totalBytes: number; percent: number };

let progressListeners: ((progress: UploadProgress) => void)[] = [];

function emitWebProgress(percent: number) {
  for (const listener of progressListeners) {
    listener({ sentBytes: 0, totalBytes: 0, percent });
  }
}

export async function uploadFiles(files: File[]): Promise<UploadResponse> {
  if (files.length === 0) {
    throw new Error("No files selected.");
  }

  let uploadFile: File;

  if (files.length === 1) {
    uploadFile = files[0]!;
  } else {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const archive = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
    });
    const archiveNames = new Map<string, number>();
    try {
      for (const file of files) {
        const entry = new ZipDeflate(getUniqueArchiveName(file.name, archiveNames));
        archive.add(entry);
        for await (const chunk of file.stream()) entry.push(chunk);
        entry.push(new Uint8Array(), true);
      }
      archive.end();
    } catch (error) {
      archive.terminate();
      throw error;
    }
    uploadFile = new File(chunks, `quickdrop-${files.length}-files.zip`, { type: "application/zip" });
  }

  const { promise, resolve, reject } = Promise.withResolvers<UploadResponse>();
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
      } catch {
        reject(new Error("Invalid server response."));
      }
    } else {
      let message = xhr.responseText || `Upload error: ${xhr.statusText}`;
      try {
        const payload: unknown = JSON.parse(xhr.responseText);
        if (payload && typeof payload === "object" && "message" in payload
          && typeof payload.message === "string" && payload.message.trim()) {
          message = payload.message;
        }
      } catch {
        // Non-JSON error responses remain readable as plain text.
      }
      reject(new Error(message));
    }
  };

  xhr.onerror = () => {
    reject(new Error("Server connection failed."));
  };

  const formData = new FormData();
  formData.append("file", uploadFile);
  xhr.setRequestHeader("x-quickdrop-file-size", uploadFile.size.toString());
  xhr.send(formData);
  return promise;
}

function getUniqueArchiveName(fileName: string, archiveNames: Map<string, number>): string {
  if (!archiveNames.has(fileName)) {
    archiveNames.set(fileName, 1);
    return fileName;
  }

  const lastDot = fileName.lastIndexOf(".");
  const stem = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  const extension = lastDot > 0 ? fileName.slice(lastDot) : "";
  let count = (archiveNames.get(fileName) ?? 1) + 1;
  let candidate = `${stem}-${count}${extension}`;
  while (archiveNames.has(candidate)) {
    count += 1;
    candidate = `${stem}-${count}${extension}`;
  }
  archiveNames.set(fileName, count);
  archiveNames.set(candidate, 1);
  return candidate;
}

export function copyLink(link: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(link);
  }

  return Promise.reject(new Error("Clipboard API is unavailable"));
}


export function onUploadProgress(handler: (progress: UploadProgress) => void): Promise<() => void> {
  progressListeners.push(handler);
  return Promise.resolve(() => {
    progressListeners = progressListeners.filter((h) => h !== handler);
  });
}
