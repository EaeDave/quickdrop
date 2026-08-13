import { describe, expect, test } from "bun:test";
import {
  createTextFunnelMetrics,
  metricDateUtc,
  retentionCutoffDate,
  startTextFunnelMetricsCleanup,
  type TextFunnelMetricsRepository,
  type TextMetricAggregate,
  type TextMetricIncrement,
} from "./text-funnel-metrics";

class InMemoryMetricsRepository implements TextFunnelMetricsRepository {
  increments: Array<{ metric: TextMetricIncrement; recordedAt: Date }> = [];
  prunedBefore: string[] = [];
  fail = false;

  async increment(metric: TextMetricIncrement, recordedAt: Date): Promise<void> {
    if (this.fail) {
      throw new Error("database unavailable");
    }
    this.increments.push({ metric, recordedAt });
  }

  async pruneBefore(metricDate: string): Promise<void> {
    this.prunedBefore.push(metricDate);
  }
  async summarySince(): Promise<TextMetricAggregate[]> {
    return [];
  }
}

describe("text funnel metrics", () => {
  test("records only the provided aggregate dimensions on the UTC day", async () => {
    const repository = new InMemoryMetricsRepository();
    const errors: string[] = [];
    const now = new Date("2026-08-13T23:59:59Z");
    const metrics = createTextFunnelMetrics({
      enabled: true,
      repository,
      logger: { error: (message) => errors.push(message) },
      now: () => now,
    });

    await metrics.record({ event: "open_or_create", roomKind: "custom", outcome: "created" });

    expect(repository.increments).toEqual([{
      metric: { event: "open_or_create", roomKind: "custom", outcome: "created" },
      recordedAt: now,
    }]);
    expect(errors).toEqual([]);
    expect(metricDateUtc(now)).toBe("2026-08-13");
  });

  test("is disabled by default without touching storage", async () => {
    const repository = new InMemoryMetricsRepository();
    const metrics = createTextFunnelMetrics({
      enabled: false,
      repository,
      logger: { error: () => {} },
    });

    await metrics.record({ event: "screen_opened" });
    expect(repository.increments).toEqual([]);
  });

  test("does not break product behavior or disclose dimensions in logs when storage fails", async () => {
    const repository = new InMemoryMetricsRepository();
    repository.fail = true;
    const errors: string[] = [];
    const metrics = createTextFunnelMetrics({
      enabled: true,
      repository,
      logger: { error: (message) => errors.push(message) },
    });

    await expect(metrics.record({ event: "client_error", errorCategory: "clipboard" })).resolves.toBeUndefined();
    expect(errors).toEqual(["Failed to increment aggregate text funnel metric."]);
  });

  test("computes the aggregate retention cutoff", () => {
    expect(retentionCutoffDate(new Date("2026-08-13T12:00:00Z"), 90)).toBe("2026-05-15");
  });

  test("prunes historical aggregates even when no new metrics are recorded", async () => {
    const repository = new InMemoryMetricsRepository();
    const timer = startTextFunnelMetricsCleanup(
      90,
      repository,
      () => new Date("2026-08-13T12:00:00Z"),
    );

    await Bun.sleep(0);
    clearInterval(timer);
    expect(repository.prunedBefore).toEqual(["2026-05-15"]);
    expect(repository.increments).toEqual([]);
  });
});
