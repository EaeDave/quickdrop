import { basename } from "node:path";

export function generateUploadId(): string {
  return crypto.randomUUID();
}

export function generateShortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export function sanitizeFilename(input: string | undefined): string {
  const baseName = basename(input ?? "");
  const sanitized = baseName
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "");

  return sanitized || "file";
}

export function buildR2Key(id: string, originalName: string, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");

  return `uploads/${year}/${month}/${id}-${sanitizeFilename(originalName)}`;
}
