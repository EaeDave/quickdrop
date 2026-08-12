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

export type TextRoomsRepository = {
  countActiveTextRooms(now: Date): Promise<number>;
  createTextRoom(input: {
    code: string;
    text: string;
    version: number;
    pinHash?: string | null;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
  }): Promise<TextRoomRow | null>;
  findTextRoomByCode(code: string): Promise<TextRoomRow | null>;
  markTextRoomActive(code: string, updatedAt: Date): Promise<void>;
  updateTextRoomText(input: { code: string; text: string; now: Date }): Promise<TextRoomRow | null>;
  scheduleTextRoomExpiry(code: string, expiresAt: Date, updatedAt: Date): Promise<void>;
  rearmOpenTextRooms(expiresAt: Date, updatedAt: Date): Promise<void>;
  findExpiredTextRooms(now: Date, limit?: number): Promise<TextRoomRow[]>;
  markTextRoomDeleted(code: string, deletedAt: Date): Promise<void>;
};

export async function countActiveTextRooms(now: Date): Promise<number> {
  const rows = await db
    .select({ count: drizzleSql<number>`count(*)` })
    .from(textRooms)
    .where(activeRoomFilter(now));
  const row = rows[0];

  return Number(row?.count ?? 0);
}

export async function createTextRoom(input: {
  code: string;
  text: string;
  version: number;
  pinHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}): Promise<TextRoomRow | null> {
  try {
    const rows = await db
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

    return row ? toTextRoomRow(row) : null;
  } catch (error) {
    if (hasPostgresUniqueViolation(error)) {
      return null;
    }

    throw error;
  }
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

export async function markTextRoomDeleted(code: string, deletedAt: Date): Promise<void> {
  await db
    .update(textRooms)
    .set({ deletedAt })
    .where(and(eq(textRooms.code, code), isNull(textRooms.deletedAt)));
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

function hasPostgresUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}

export const textRoomsRepository: TextRoomsRepository = {
  countActiveTextRooms,
  createTextRoom,
  findTextRoomByCode,
  markTextRoomActive,
  updateTextRoomText,
  scheduleTextRoomExpiry,
  rearmOpenTextRooms,
  findExpiredTextRooms,
  markTextRoomDeleted,
};
