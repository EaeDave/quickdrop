import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey(),
    shortId: varchar("short_id", { length: 32 }).notNull().unique(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    r2Key: text("r2_key").notNull(),
    downloadCount: integer("download_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("uploads_expired_cleanup_idx").on(table.expiresAt).where(sql`${table.deletedAt} is null`),
  ],
);

export type UploadRecord = typeof uploads.$inferSelect;

export const textRooms = pgTable(
  "text_rooms",
  {
    code: varchar("code", { length: 16 }).primaryKey(),
    text: text("text").notNull().default(""),
    version: integer("version").default(0).notNull(),
    pinHash: text("pin_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("text_rooms_expires_idx").on(table.expiresAt).where(sql`${table.deletedAt} is null`),
  ],
);

export type TextRoomRecord = typeof textRooms.$inferSelect;
