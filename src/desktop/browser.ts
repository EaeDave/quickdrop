import { zip } from "fflate";

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
  return promise;
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
