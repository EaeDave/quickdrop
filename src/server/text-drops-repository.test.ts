import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { textRooms } from "./schema";
import { createTextRoomWithinLimit } from "./text-rooms-repository";
import { clearDrops, createDrop, deleteDrop, listActiveDrops } from "./text-drops-repository";

const createdRoomIds: string[] = [];

afterEach(async () => {
  for (const roomId of createdRoomIds.splice(0)) {
    await db.delete(textRooms).where(eq(textRooms.id, roomId));
  }
});

describe("text drops repository", () => {
  test("does not restore expired content when deleting the newest active drop", async () => {
    const now = new Date();
    const code = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`.toUpperCase();
    const creation = await createTextRoomWithinLimit({
      code,
      kind: "custom",
      text: "",
      version: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    }, 500, now);
    if (creation.status !== "created") {
      throw new Error(`expected room creation, got ${creation.status}`);
    }
    createdRoomIds.push(creation.room.id);

    const expired = await createDrop({
      roomId: creation.room.id,
      content: "expired secret",
      contentType: "text",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 5_000),
    }, 10);
    expect(expired).toMatchObject({ drop: { content: "expired secret" } });
    const latest = await createDrop({
      roomId: creation.room.id,
      content: "active item",
      contentType: "text",
      createdAt: new Date(now.getTime() + 1_000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    }, 10);
    if (!latest) {
      throw new Error("expected latest drop creation");
    }

    const deletedAt = new Date(now.getTime() + 10_000);
    const deleted = await deleteDrop(creation.room.id, latest.drop.id, deletedAt);
    expect(deleted).toMatchObject({ deleted: true, legacyText: "" });
    expect(await listActiveDrops(creation.room.id, deletedAt, 10)).toEqual([]);
    const roomRows = await db
      .select({ text: textRooms.text })
      .from(textRooms)
      .where(eq(textRooms.id, creation.room.id));
    expect(roomRows[0]?.text).toBe("");
  });

  test("serializes concurrent inserts and enforces the hard 10-item limit", async () => {
    const now = new Date();
    const code = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`.toUpperCase();
    const creation = await createTextRoomWithinLimit({
      code,
      kind: "custom",
      text: "",
      version: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    }, 500, now);
    if (creation.status !== "created") {
      throw new Error(`expected room creation, got ${creation.status}`);
    }
    createdRoomIds.push(creation.room.id);

    const results = await Promise.all(
      Array.from({ length: 11 }, (_, index) => createDrop({
        roomId: creation.room.id,
        content: `concurrent item ${index}`,
        contentType: "text",
        createdAt: new Date(now.getTime() + index),
        expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      }, 10)),
    );

    const timeline = await listActiveDrops(creation.room.id, now, 20);
    const timelineContents = new Set(timeline.map((drop) => drop.content));
    expect(timeline).toHaveLength(10);
    expect(results.every((result) => result !== null)).toBe(true);
    expect(timelineContents.size).toBe(10);
    expect(timelineContents).toEqual(
      new Set(Array.from({ length: 10 }, (_, index) => `concurrent item ${index + 1}`)),
    );
    expect(results.filter((result) => result?.firstDrop)).toHaveLength(1);

    const deleted = await deleteDrop(creation.room.id, timeline[0]!.id, new Date(now.getTime() + 20));
    expect(deleted?.deleted).toBe(true);
    expect(await listActiveDrops(creation.room.id, now, 20)).toHaveLength(9);

    const cleared = await clearDrops(creation.room.id, new Date(now.getTime() + 30));
    expect(cleared?.deletedIds).toHaveLength(9);
    expect(await listActiveDrops(creation.room.id, now, 20)).toEqual([]);
  });
});
