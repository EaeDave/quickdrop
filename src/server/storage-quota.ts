import { eq, lte, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import { generateShortId } from "./ids";
import { storageQuota, storageReservations, uploads } from "./schema";
import { toUploadRow, type UploadRow } from "./uploads-repository";

const GLOBAL_STORAGE_QUOTA_ID = "global";
const UNIQUE_VIOLATION_CODE = "23505";

export type StorageReservation = {
  id: string;
  sizeBytes: number;
  expiresAt: Date;
};

export type ReserveUploadStorageResult =
  | { ok: true; reservation: StorageReservation }
  | { ok: false; reason: "disabled" | "quota_exceeded" };

export class StorageReservationExpiredError extends Error {
  readonly code = "QUICKDROP_STORAGE_RESERVATION_EXPIRED";

  constructor() {
    super("storage reservation expired");
  }
}

export async function reserveUploadStorage(input: {
  sizeBytes: number;
  hardLimitBytes: number;
  reservationTtlMs: number;
  uploadsEnabled: boolean;
  now?: Date;
}): Promise<ReserveUploadStorageResult> {
  if (!input.uploadsEnabled) {
    return { ok: false, reason: "disabled" };
  }

  const now = input.now ?? new Date();
  const sizeBytes = BigInt(input.sizeBytes);
  const hardLimitBytes = BigInt(input.hardLimitBytes);
  const reservationId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + input.reservationTtlMs);

  return db.transaction(async (tx) => {
    await tx
      .insert(storageQuota)
      .values({ id: GLOBAL_STORAGE_QUOTA_ID, activeBytes: 0n, reservedBytes: 0n, updatedAt: now })
      .onConflictDoNothing();

    const quotaRows = await tx
      .update(storageQuota)
      .set({
        reservedBytes: drizzleSql`${storageQuota.reservedBytes} + ${sizeBytes}`,
        updatedAt: now,
      })
      .where(
        drizzleSql`${storageQuota.id} = ${GLOBAL_STORAGE_QUOTA_ID} and ${storageQuota.activeBytes} + ${storageQuota.reservedBytes} + ${sizeBytes} <= ${hardLimitBytes}`,
      )
      .returning({ id: storageQuota.id });

    if (!quotaRows[0]) {
      return { ok: false, reason: "quota_exceeded" };
    }

    await tx.insert(storageReservations).values({
      id: reservationId,
      sizeBytes,
      createdAt: now,
      expiresAt,
    });

    return { ok: true, reservation: { id: reservationId, sizeBytes: input.sizeBytes, expiresAt } };
  });
}

export async function registerUploadWithStorageReservation(input: {
  reservationId: string;
  id: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  r2Key: string;
  createdAt: Date;
  expiresAt: Date;
}): Promise<UploadRow> {
  let lastUniqueError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const reservationRows = await tx
          .delete(storageReservations)
          .where(eq(storageReservations.id, input.reservationId))
          .returning({ sizeBytes: storageReservations.sizeBytes });
        const reservation = reservationRows[0];

        if (!reservation || reservation.sizeBytes !== BigInt(input.sizeBytes)) {
          throw new StorageReservationExpiredError();
        }

        const rows = await tx
          .insert(uploads)
          .values({
            id: input.id,
            shortId: generateShortId(),
            originalName: input.originalName,
            mimeType: input.mimeType,
            sizeBytes: reservation.sizeBytes,
            r2Key: input.r2Key,
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
          })
          .returning();
        const row = rows[0];

        if (!row) {
          throw new Error("Insert did not return an upload row");
        }

        await tx
          .update(storageQuota)
          .set({
            activeBytes: drizzleSql`${storageQuota.activeBytes} + ${reservation.sizeBytes}`,
            reservedBytes: drizzleSql`greatest(${storageQuota.reservedBytes} - ${reservation.sizeBytes}, ${0n})`,
            updatedAt: input.createdAt,
          })
          .where(eq(storageQuota.id, GLOBAL_STORAGE_QUOTA_ID));

        return toUploadRow(row);
      });
    } catch (error) {
      if (!hasPostgresUniqueViolation(error)) {
        throw error;
      }

      lastUniqueError = error;
    }
  }

  throw lastUniqueError ?? new Error("Could not generate a unique short_id");
}

export async function releaseUploadStorageReservation(
  reservationId: string,
  now = new Date(),
): Promise<{ released: boolean; bytes: number }> {
  const releasedBytes = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(storageReservations)
      .where(eq(storageReservations.id, reservationId))
      .returning({ sizeBytes: storageReservations.sizeBytes });
    const reservation = rows[0];

    if (!reservation) {
      return 0n;
    }

    await tx
      .update(storageQuota)
      .set({
        reservedBytes: drizzleSql`greatest(${storageQuota.reservedBytes} - ${reservation.sizeBytes}, ${0n})`,
        updatedAt: now,
      })
      .where(eq(storageQuota.id, GLOBAL_STORAGE_QUOTA_ID));

    return reservation.sizeBytes;
  });

  return { released: releasedBytes > 0n, bytes: Number(releasedBytes) };
}

export async function releaseExpiredStorageReservations(
  now = new Date(),
): Promise<{ released: number; bytes: number }> {
  const released = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(storageReservations)
      .where(lte(storageReservations.expiresAt, now))
      .returning({ sizeBytes: storageReservations.sizeBytes });

    if (rows.length === 0) {
      return { count: 0, bytes: 0n };
    }

    const bytes = rows.reduce((total, row) => total + row.sizeBytes, 0n);

    await tx
      .update(storageQuota)
      .set({
        reservedBytes: drizzleSql`greatest(${storageQuota.reservedBytes} - ${bytes}, ${0n})`,
        updatedAt: now,
      })
      .where(eq(storageQuota.id, GLOBAL_STORAGE_QUOTA_ID));

    return { count: rows.length, bytes };
  });

  return { released: released.count, bytes: Number(released.bytes) };
}

function hasPostgresUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  while (current && typeof current === "object") {
    if ("code" in current && current.code === UNIQUE_VIOLATION_CODE) {
      return true;
    }

    if (!("cause" in current)) {
      return false;
    }

    current = current.cause;
  }

  return false;
}
