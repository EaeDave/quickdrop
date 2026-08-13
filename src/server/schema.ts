import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

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

export const storageQuota = pgTable("storage_quota", {
  id: varchar("id", { length: 32 }).primaryKey(),
  activeBytes: bigint("active_bytes", { mode: "bigint" }).default(0n).notNull(),
  reservedBytes: bigint("reserved_bytes", { mode: "bigint" }).default(0n).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export type StorageQuotaRecord = typeof storageQuota.$inferSelect;

export const storageReservations = pgTable(
  "storage_reservations",
  {
    id: uuid("id").primaryKey(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("storage_reservations_expires_idx").on(table.expiresAt)],
);

export type StorageReservationRecord = typeof storageReservations.$inferSelect;

export const textRooms = pgTable(
  "text_rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 16 }).notNull(),
    kind: varchar("kind", { length: 16 }).default("generated").notNull(),
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
    uniqueIndex("text_rooms_active_code_unique").on(table.code).where(sql`${table.deletedAt} is null`),
  ],
);

export type TextRoomRecord = typeof textRooms.$inferSelect;

export const textFunnelMetrics = pgTable(
  "text_funnel_metrics",
  {
    metricDate: date("metric_date").notNull(),
    event: varchar("event", { length: 32 }).notNull(),
    roomKind: varchar("room_kind", { length: 16 }).default("none").notNull(),
    outcome: varchar("outcome", { length: 32 }).default("none").notNull(),
    errorCategory: varchar("error_category", { length: 32 }).default("none").notNull(),
    count: bigint("count", { mode: "bigint" }).default(0n).notNull(),
  },
  (table) => [
    primaryKey({
      name: "text_funnel_metrics_pk",
      columns: [table.metricDate, table.event, table.roomKind, table.outcome, table.errorCategory],
    }),
    check("text_funnel_metrics_count_check", sql`${table.count} >= 0`),
  ],
);

export type TextFunnelMetricRecord = typeof textFunnelMetrics.$inferSelect;
