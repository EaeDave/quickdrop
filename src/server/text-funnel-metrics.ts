import { gte, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { textFunnelMetrics } from "./schema";

export const TEXT_METRIC_EVENTS = [
  "screen_opened",
  "open_or_create",
  "first_publish",
  "second_device",
  "text_copied",
  "client_error",
] as const;

export const TEXT_METRIC_ERROR_CATEGORIES = [
  "none",
  "invalid_code",
  "pin_required",
  "pin_invalid",
  "invalid_token",
  "not_found",
  "session_limit",
  "room_full",
  "too_large",
  "clipboard",
  "network",
  "unknown",
] as const;

export type TextMetricEvent = (typeof TEXT_METRIC_EVENTS)[number];
export type TextMetricRoomKind = "none" | "custom" | "generated";
export type TextMetricOutcome = "none" | "created" | "opened" | "success" | "error";
export type TextMetricErrorCategory = (typeof TEXT_METRIC_ERROR_CATEGORIES)[number];

export type TextMetricIncrement = {
  event: TextMetricEvent;
  roomKind?: Exclude<TextMetricRoomKind, "none">;
  outcome?: Exclude<TextMetricOutcome, "none">;
  errorCategory?: Exclude<TextMetricErrorCategory, "none">;
};

export type TextMetricAggregate = {
  metricDate: string;
  event: TextMetricEvent;
  roomKind: TextMetricRoomKind;
  outcome: TextMetricOutcome;
  errorCategory: TextMetricErrorCategory;
  count: bigint;
};

export type TextFunnelMetricsRepository = {
  increment(metric: TextMetricIncrement, recordedAt: Date): Promise<void>;
  pruneBefore(metricDate: string): Promise<void>;
  summarySince(metricDate: string): Promise<TextMetricAggregate[]>;
};

export type TextFunnelMetrics = {
  record(metric: TextMetricIncrement): Promise<void>;
};

type MetricsLogger = {
  error(message: string): void;
};

export function createTextFunnelMetrics(options: {
  enabled: boolean;
  repository?: TextFunnelMetricsRepository;
  logger: MetricsLogger;
  now?: () => Date;
}): TextFunnelMetrics {
  const repository = options.repository ?? textFunnelMetricsRepository;
  const now = options.now ?? (() => new Date());

  return {
    async record(metric) {
      if (!options.enabled) {
        return;
      }

      try {
        await repository.increment(metric, now());
      } catch {
        // Product behavior must never fail because aggregate metrics are unavailable.
        options.logger.error("Failed to increment aggregate text funnel metric.");
      }
    },
  };
}

export async function incrementTextFunnelMetric(
  metric: TextMetricIncrement,
  recordedAt: Date,
): Promise<void> {
  const values = normalizeMetric(metric, recordedAt);
  await db
    .insert(textFunnelMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: [
        textFunnelMetrics.metricDate,
        textFunnelMetrics.event,
        textFunnelMetrics.roomKind,
        textFunnelMetrics.outcome,
        textFunnelMetrics.errorCategory,
      ],
      set: { count: sql`${textFunnelMetrics.count} + 1` },
    });
}

export async function pruneTextFunnelMetricsBefore(metricDate: string): Promise<void> {
  await db.delete(textFunnelMetrics).where(lt(textFunnelMetrics.metricDate, metricDate));
}

export async function textFunnelMetricsSummarySince(metricDate: string): Promise<TextMetricAggregate[]> {
  const rows = await db
    .select()
    .from(textFunnelMetrics)
    .where(gte(textFunnelMetrics.metricDate, metricDate))
    .orderBy(
      textFunnelMetrics.metricDate,
      textFunnelMetrics.event,
      textFunnelMetrics.roomKind,
      textFunnelMetrics.outcome,
      textFunnelMetrics.errorCategory,
    );

  return rows.map((row) => ({
    metricDate: row.metricDate,
    event: row.event as TextMetricEvent,
    roomKind: row.roomKind as TextMetricRoomKind,
    outcome: row.outcome as TextMetricOutcome,
    errorCategory: row.errorCategory as TextMetricErrorCategory,
    count: row.count,
  }));
}

export function metricDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function retentionCutoffDate(now: Date, retentionDays: number): string {
  return metricDateUtc(new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000));
}

export function startTextFunnelMetricsCleanup(
  retentionDays: number,
  repository: TextFunnelMetricsRepository = textFunnelMetricsRepository,
  now: () => Date = () => new Date(),
): ReturnType<typeof setInterval> {
  const prune = () => {
    void repository.pruneBefore(retentionCutoffDate(now(), retentionDays)).catch(() => {
      console.error("Failed to prune aggregate text funnel metrics.");
    });
  };

  prune();
  const timer = setInterval(prune, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

function normalizeMetric(metric: TextMetricIncrement, recordedAt: Date) {
  return {
    metricDate: metricDateUtc(recordedAt),
    event: metric.event,
    roomKind: metric.roomKind ?? "none",
    outcome: metric.outcome ?? "none",
    errorCategory: metric.errorCategory ?? "none",
    count: 1n,
  };
}

export const textFunnelMetricsRepository: TextFunnelMetricsRepository = {
  increment: incrementTextFunnelMetric,
  pruneBefore: pruneTextFunnelMetricsBefore,
  summarySince: textFunnelMetricsSummarySince,
};
