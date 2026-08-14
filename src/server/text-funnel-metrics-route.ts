import type { FastifyInstance } from "fastify";
import {
  TEXT_METRIC_ERROR_CATEGORIES,
  type TextFunnelMetrics,
  type TextMetricErrorCategory,
  type TextMetricIncrement,
} from "./text-funnel-metrics";

const CLIENT_EVENTS = ["screen_opened", "text_copied", "client_error"] as const;
const CLIENT_ERROR_CATEGORIES = TEXT_METRIC_ERROR_CATEGORIES.filter(
  (category) => category !== "none",
);

export function registerTextFunnelMetricsRoute(
  app: FastifyInstance,
  metrics: TextFunnelMetrics,
): void {
  app.post(
    "/api/text/metrics",
    {
      bodyLimit: 512,
      preHandler: app.rateLimit({ max: 120, timeWindow: "1 hour" }),
    },
    async (request, reply) => {
      const metric = parseClientTextMetric(request.body);
      if (!metric) {
        reply.code(400).send({ error: "invalid_metric", message: "Invalid metric." });
        return;
      }

      await metrics.record(metric);
      reply.code(204).send();
    },
  );
}

export function parseClientTextMetric(body: unknown): TextMetricIncrement | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const value = body as Record<string, unknown>;
  if (typeof value.event !== "string" || !CLIENT_EVENTS.includes(value.event as (typeof CLIENT_EVENTS)[number])) {
    return null;
  }

  const allowedKeys = value.event === "screen_opened"
    ? ["event"]
    : value.event === "text_copied"
      ? ["event", "roomKind"]
      : ["event", "roomKind", "errorCategory"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return null;
  }

  if (value.event === "screen_opened") {
    return Object.keys(value).length === 1 ? { event: "screen_opened" } : null;
  }

  const roomKind = value.roomKind;
  if (roomKind !== undefined && roomKind !== "custom" && roomKind !== "generated") {
    return null;
  }

  if (value.event === "text_copied") {
    return roomKind ? { event: "text_copied", roomKind } : { event: "text_copied" };
  }

  const errorCategory = value.errorCategory;
  if (
    typeof errorCategory !== "string" ||
    !CLIENT_ERROR_CATEGORIES.includes(errorCategory as (typeof CLIENT_ERROR_CATEGORIES)[number])
  ) {
    return null;
  }

  return {
    event: "client_error",
    ...(roomKind ? { roomKind } : {}),
    errorCategory: errorCategory as Exclude<TextMetricErrorCategory, "none">,
    outcome: "error",
  };
}
