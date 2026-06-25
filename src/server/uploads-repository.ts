import { and, asc, eq, isNull, lte, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import { storageQuota, uploads, type UploadRecord } from "./schema";

export type UploadRow = {
  id: string;
  short_id: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: bigint;
  r2_key: string;
  download_count: number;
  created_at: Date;
  expires_at: Date;
  deleted_at: Date | null;
};

export async function insertUpload(input: {
  id: string;
  shortId: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  r2Key: string;
  createdAt: Date;
  expiresAt: Date;
}): Promise<UploadRow> {
  const rows = await db
    .insert(uploads)
    .values({
      id: input.id,
      shortId: input.shortId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      r2Key: input.r2Key,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = rows[0];

  if (!row) {
    throw new Error("Insert did not return an upload row");
  }

  return toUploadRow(row);
}

export async function findActiveByShortId(shortId: string): Promise<UploadRow | null> {
  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.shortId, shortId), isNull(uploads.deletedAt)))
    .limit(1);
  const row = rows[0];

  return row ? toUploadRow(row) : null;
}

export async function incrementDownloadCount(id: string): Promise<void> {
  await db
    .update(uploads)
    .set({ downloadCount: drizzleSql`${uploads.downloadCount} + 1` })
    .where(eq(uploads.id, id));
}

export async function findExpired(now: Date, limit = 100): Promise<UploadRow[]> {
  const rows = await db
    .select()
    .from(uploads)
    .where(and(lte(uploads.expiresAt, now), isNull(uploads.deletedAt)))
    .orderBy(asc(uploads.expiresAt))
    .limit(limit);

  return rows.map(toUploadRow);
}

export async function markDeleted(id: string, deletedAt: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(uploads)
      .set({ deletedAt })
      .where(and(eq(uploads.id, id), isNull(uploads.deletedAt)))
      .returning({ sizeBytes: uploads.sizeBytes });
    const row = rows[0];

    if (!row) {
      return;
    }

    await tx
      .insert(storageQuota)
      .values({ id: "global", activeBytes: 0n, reservedBytes: 0n, updatedAt: deletedAt })
      .onConflictDoNothing();

    await tx
      .update(storageQuota)
      .set({
        activeBytes: drizzleSql`greatest(${storageQuota.activeBytes} - ${row.sizeBytes}, ${0n})`,
        updatedAt: deletedAt,
      })
      .where(eq(storageQuota.id, "global"));
  });
}

export function toUploadRow(row: UploadRecord): UploadRow {
  return {
    id: row.id,
    short_id: row.shortId,
    original_name: row.originalName,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    r2_key: row.r2Key,
    download_count: row.downloadCount,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    deleted_at: row.deletedAt,
  };
}
