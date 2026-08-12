import { and, asc, eq, gt, isNull, lte, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import { textRooms, type TextRoomRecord } from "./schema";

export type TextRoomRow = {
  id: string;
  code: string;
  text: string;
  version: number;
  pin_hash: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  deleted_at: Date | null;
};

export type CreateTextRoomInput = {
  code: string;
  text: string;
  version: number;
  pinHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type TextRoomCreationResult =
  | { status: "created"; room: TextRoomRow }
  | { status: "conflict" }
  | { status: "limit" };

export type TextRoomsRepository = {
  createTextRoomWithinLimit(input: CreateTextRoomInput, maxSessions: number, now: Date): Promise<TextRoomCreationResult>;
  findTextRoomByCode(code: string): Promise<TextRoomRow | null>;
  markTextRoomActive(code: string, updatedAt: Date): Promise<void>;
  updateTextRoomText(input: { code: string; text: string; now: Date }): Promise<TextRoomRow | null>;
  scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void>;
  rearmOpenTextRooms(expiresAt: Date, updatedAt: Date): Promise<void>;
  findExpiredTextRooms(now: Date, limit?: number): Promise<TextRoomRow[]>;
  markTextRoomDeleted(id: string, deletedAt: Date): Promise<void>;
};

export async function createTextRoomWithinLimit(
  input: CreateTextRoomInput,
  maxSessions: number,
  now: Date,
): Promise<TextRoomCreationResult> {
  return db.transaction(async (tx) => {
    // Serialize capacity checks across every room-creation path. Code conflicts
    // remain protected independently by the partial unique index.
    await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtext('quickdrop:text-room-capacity'))`);
    const existingRows = await tx
      .select({ id: textRooms.id })
      .from(textRooms)
      .where(and(eq(textRooms.code, input.code), isNull(textRooms.deletedAt)))
      .limit(1);
    if (existingRows.length > 0) {
      return { status: "conflict" };
    }

    const countRows = await tx
      .select({ count: drizzleSql<number>`count(*)` })
      .from(textRooms)
      .where(activeRoomFilter(now));
    if (Number(countRows[0]?.count ?? 0) >= maxSessions) {
      return { status: "limit" };
    }

    const rows = await tx
      .insert(textRooms)
      .values({
        code: input.code,
        text: input.text,
        version: input.version,
        pinHash: input.pinHash ?? null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];

    return row
      ? { status: "created", room: toTextRoomRow(row) }
      : { status: "conflict" };
  });
}

export async function findTextRoomByCode(code: string): Promise<TextRoomRow | null> {
  const rows = await db
    .select()
    .from(textRooms)
    .where(and(eq(textRooms.code, code), isNull(textRooms.deletedAt)))
    .limit(1);
  const row = rows[0];

  return row ? toTextRoomRow(row) : null;
}

export async function markTextRoomActive(code: string, updatedAt: Date): Promise<void> {
  await db
    .update(textRooms)
    .set({ updatedAt, expiresAt: null })
    .where(and(eq(textRooms.code, code), isNull(textRooms.deletedAt)));
}

export async function updateTextRoomText(input: {
  code: string;
  text: string;
  now: Date;
}): Promise<TextRoomRow | null> {
  const rows = await db
    .update(textRooms)
    .set({
      text: input.text,
      updatedAt: input.now,
      version: drizzleSql`${textRooms.version} + 1`,
    })
    .where(and(eq(textRooms.code, input.code), isNull(textRooms.deletedAt)))
    .returning();
  const row = rows[0];

  return row ? toTextRoomRow(row) : null;
}

export async function scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void> {
  await db
    .update(textRooms)
    .set({ expiresAt, updatedAt })
    .where(and(eq(textRooms.code, code), isNull(textRooms.deletedAt)));
}

export async function rearmOpenTextRooms(expiresAt: Date, updatedAt: Date): Promise<void> {
  await db
    .update(textRooms)
    .set({ expiresAt, updatedAt })
    .where(and(isNull(textRooms.deletedAt), isNull(textRooms.expiresAt)));
}

export async function findExpiredTextRooms(now: Date, limit = 100): Promise<TextRoomRow[]> {
  const rows = await db
    .select()
    .from(textRooms)
    .where(and(isNull(textRooms.deletedAt), lte(textRooms.expiresAt, now)))
    .orderBy(asc(textRooms.expiresAt))
    .limit(limit);

  return rows.map(toTextRoomRow);
}

export async function markTextRoomDeleted(id: string, deletedAt: Date): Promise<void> {
  await db
    .update(textRooms)
    .set({ deletedAt })
    .where(and(eq(textRooms.id, id), isNull(textRooms.deletedAt)));
}

function activeRoomFilter(now: Date) {
  return and(
    isNull(textRooms.deletedAt),
    or(isNull(textRooms.expiresAt), gt(textRooms.expiresAt, now)),
  );
}

function toTextRoomRow(row: TextRoomRecord): TextRoomRow {
  return {
    id: row.id,
    code: row.code,
    text: row.text,
    version: row.version,
    pin_hash: row.pinHash,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    expires_at: row.expiresAt,
    deleted_at: row.deletedAt,
  };
}

export const textRoomsRepository: TextRoomsRepository = {
  createTextRoomWithinLimit,
  findTextRoomByCode,
  markTextRoomActive,
  updateTextRoomText,
  scheduleTextRoomExpiry,
  rearmOpenTextRooms,
  findExpiredTextRooms,
  markTextRoomDeleted,
};
