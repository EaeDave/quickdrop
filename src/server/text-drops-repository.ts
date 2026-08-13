import { and, desc, eq, gt, inArray, isNull, lte, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import { textDrops, textRooms, type TextDropRecord } from "./schema";
import type { TextDropContentType } from "./text-drop-content";

export type TextDropRow = {
  id: string;
  room_id: string;
  content: string;
  content_type: TextDropContentType;
  created_at: Date;
  expires_at: Date;
};

export type CreateTextDropInput = {
  roomId: string;
  content: string;
  contentType: TextDropContentType;
  createdAt: Date;
  expiresAt: Date;
};

export type UpdateTextDropInput = {
  roomId: string;
  dropId: string;
  content: string;
  contentType: TextDropContentType;
  updatedAt: Date;
};

export type TextDropMutationResult = {
  legacyText: string;
  legacyVersion: number;
};

export type CreateTextDropResult = TextDropMutationResult & {
  drop: TextDropRow;
  evictedIds: string[];
  firstDrop: boolean;
};

export type DeleteTextDropResult = TextDropMutationResult & {
  deleted: boolean;
};

export type UpdateTextDropResult = TextDropMutationResult & {
  drop: TextDropRow | null;
};

export type ClearTextDropsResult = TextDropMutationResult & {
  deletedIds: string[];
};

export type TextDropsRepository = {
  listActiveDrops(roomId: string, now: Date, limit: number): Promise<TextDropRow[]>;
  createDrop(input: CreateTextDropInput, maxItems: number): Promise<CreateTextDropResult | null>;
  updateDrop(input: UpdateTextDropInput): Promise<UpdateTextDropResult | null>;
  deleteDrop(roomId: string, dropId: string, deletedAt: Date): Promise<DeleteTextDropResult | null>;
  clearDrops(roomId: string, deletedAt: Date): Promise<ClearTextDropsResult | null>;
  findExpiredDrops(now: Date, limit?: number): Promise<TextDropRow[]>;
  markDropsDeleted(ids: string[], deletedAt: Date): Promise<void>;
};

export async function listActiveDrops(roomId: string, now: Date, limit: number): Promise<TextDropRow[]> {
  const rows = await db
    .select()
    .from(textDrops)
    .where(and(eq(textDrops.roomId, roomId), gt(textDrops.expiresAt, now)))
    .orderBy(desc(textDrops.createdAt), desc(textDrops.id))
    .limit(limit);

  return rows.map(toTextDropRow);
}

export async function createDrop(
  input: CreateTextDropInput,
  maxItems: number,
): Promise<CreateTextDropResult | null> {
  return db.transaction(async (tx) => {
    await lockRoom(tx, input.roomId);
    await tx
      .delete(textDrops)
      .where(and(
        eq(textDrops.roomId, input.roomId),
        lte(textDrops.expiresAt, input.createdAt),
      ));

    const roomStateRows = await tx
      .select({ dropsStartedAt: textRooms.dropsStartedAt })
      .from(textRooms)
      .where(and(eq(textRooms.id, input.roomId), isNull(textRooms.deletedAt)))
      .limit(1);
    const roomState = roomStateRows[0];
    if (!roomState) {
      return null;
    }

    const insertedRows = await tx
      .insert(textDrops)
      .values({
        roomId: input.roomId,
        content: input.content,
        contentType: input.contentType,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    const inserted = insertedRows[0];
    if (!inserted) {
      return null;
    }

    const roomRows = await tx
      .update(textRooms)
      .set({
        text: input.content,
        version: drizzleSql`${textRooms.version} + 1`,
        updatedAt: input.createdAt,
        dropsStartedAt: drizzleSql`coalesce(${textRooms.dropsStartedAt}, ${input.createdAt})`,
      })
      .where(and(eq(textRooms.id, input.roomId), isNull(textRooms.deletedAt)))
      .returning({ text: textRooms.text, version: textRooms.version });
    const room = roomRows[0];
    if (!room) {
      throw new Error("text room disappeared while adding a drop");
    }

    const overflowRows = await tx
      .select({ id: textDrops.id })
      .from(textDrops)
      .where(eq(textDrops.roomId, input.roomId))
      .orderBy(desc(textDrops.createdAt), desc(textDrops.id))
      .offset(maxItems);
    const evictedIds = overflowRows.map((row) => row.id);
    if (evictedIds.length > 0) {
      await tx.delete(textDrops).where(inArray(textDrops.id, evictedIds));
    }

    return {
      drop: toTextDropRow(inserted),
      evictedIds,
      firstDrop: roomState.dropsStartedAt === null,
      legacyText: room.text,
      legacyVersion: room.version,
    };
  });
}

export async function updateDrop(input: UpdateTextDropInput): Promise<UpdateTextDropResult | null> {
  return db.transaction(async (tx) => {
    await lockRoom(tx, input.roomId);
    const roomRows = await tx
      .select({ text: textRooms.text, version: textRooms.version })
      .from(textRooms)
      .where(and(eq(textRooms.id, input.roomId), isNull(textRooms.deletedAt)))
      .limit(1);
    const room = roomRows[0];
    if (!room) {
      return null;
    }
    const updatedRows = await tx
      .update(textDrops)
      .set({
        content: input.content,
        contentType: input.contentType,
      })
      .where(and(
        eq(textDrops.id, input.dropId),
        eq(textDrops.roomId, input.roomId),
        gt(textDrops.expiresAt, input.updatedAt),
      ))
      .returning();
    const updated = updatedRows[0];

    if (!updated) {
      return { drop: null, legacyText: room.text, legacyVersion: room.version };
    }

    const legacy = await updateLegacyRoomFromLatestDrop(tx, input.roomId, input.updatedAt);
    if (!legacy) {
      throw new Error("text room disappeared while editing a drop");
    }
    return { drop: toTextDropRow(updated), ...legacy };
  });
}

export async function deleteDrop(
  roomId: string,
  dropId: string,
  deletedAt: Date,
): Promise<DeleteTextDropResult | null> {
  return db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const deletedRows = await tx
      .delete(textDrops)
      .where(and(
        eq(textDrops.id, dropId),
        eq(textDrops.roomId, roomId),
      ))
      .returning({ id: textDrops.id });

    if (deletedRows.length === 0) {
      const roomRows = await tx
        .select({ text: textRooms.text, version: textRooms.version })
        .from(textRooms)
        .where(and(eq(textRooms.id, roomId), isNull(textRooms.deletedAt)))
        .limit(1);
      const room = roomRows[0];
      return room ? { deleted: false, legacyText: room.text, legacyVersion: room.version } : null;
    }

    const legacy = await updateLegacyRoomFromLatestDrop(tx, roomId, deletedAt);
    return legacy ? { deleted: true, ...legacy } : null;
  });
}

export async function clearDrops(roomId: string, deletedAt: Date): Promise<ClearTextDropsResult | null> {
  return db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const deletedRows = await tx
      .delete(textDrops)
      .where(eq(textDrops.roomId, roomId))
      .returning({ id: textDrops.id });

    const roomRows = await tx
      .update(textRooms)
      .set({
        text: "",
        version: drizzleSql`${textRooms.version} + 1`,
        updatedAt: deletedAt,
      })
      .where(and(eq(textRooms.id, roomId), isNull(textRooms.deletedAt)))
      .returning({ text: textRooms.text, version: textRooms.version });
    const room = roomRows[0];
    return room
      ? {
          deletedIds: deletedRows.map((row) => row.id),
          legacyText: room.text,
          legacyVersion: room.version,
        }
      : null;
  });
}

export async function findExpiredDrops(now: Date, limit = 200): Promise<TextDropRow[]> {
  const rows = await db
    .select()
    .from(textDrops)
    .where(lte(textDrops.expiresAt, now))
    .orderBy(textDrops.expiresAt)
    .limit(limit);
  return rows.map(toTextDropRow);
}

export async function markDropsDeleted(ids: string[], deletedAt: Date): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    const roomRows = await tx
      .selectDistinct({ roomId: textDrops.roomId })
      .from(textDrops)
      .where(inArray(textDrops.id, ids));
    const roomIds = roomRows.map((row) => row.roomId).sort();
    for (const roomId of roomIds) {
      await lockRoom(tx, roomId);
    }

    await tx.delete(textDrops).where(inArray(textDrops.id, ids));
    for (const roomId of roomIds) {
      await updateLegacyRoomFromLatestDrop(tx, roomId, deletedAt);
    }
  });
}

async function updateLegacyRoomFromLatestDrop(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  roomId: string,
  updatedAt: Date,
): Promise<TextDropMutationResult | null> {
  const latestRows = await tx
    .select({ content: textDrops.content })
    .from(textDrops)
    .where(and(eq(textDrops.roomId, roomId), gt(textDrops.expiresAt, updatedAt)))
    .orderBy(desc(textDrops.createdAt), desc(textDrops.id))
    .limit(1);
  const latestText = latestRows[0]?.content ?? "";
  const roomRows = await tx
    .update(textRooms)
    .set({
      text: latestText,
      version: drizzleSql`${textRooms.version} + 1`,
      updatedAt,
    })
    .where(and(eq(textRooms.id, roomId), isNull(textRooms.deletedAt)))
    .returning({ text: textRooms.text, version: textRooms.version });
  const room = roomRows[0];
  return room ? { legacyText: room.text, legacyVersion: room.version } : null;
}

async function lockRoom(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  roomId: string,
): Promise<void> {
  await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtextextended(${roomId}, 0))`);
}

function toTextDropRow(row: TextDropRecord): TextDropRow {
  return {
    id: row.id,
    room_id: row.roomId,
    content: row.content,
    content_type: normalizeContentType(row.contentType),
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}

function normalizeContentType(value: string): TextDropContentType {
  return value === "url" || value === "command" || value === "json" ? value : "text";
}

export const textDropsRepository: TextDropsRepository = {
  listActiveDrops,
  createDrop,
  updateDrop,
  deleteDrop,
  clearDrops,
  findExpiredDrops,
  markDropsDeleted,
};
