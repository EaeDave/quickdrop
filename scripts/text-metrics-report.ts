import { sql } from "../src/server/db";
import {
  retentionCutoffDate,
  textFunnelMetricsRepository,
  type TextMetricAggregate,
  type TextMetricEvent,
} from "../src/server/text-funnel-metrics";

const days = readDays(process.argv.slice(2));
const since = retentionCutoffDate(new Date(), days - 1);

try {
  const rows = await textFunnelMetricsRepository.summarySince(since);
  printReport(rows, days, since);
  await sql.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await sql.close({ timeout: 0 });
  process.exit(1);
}

function readDays(args: string[]): number {
  const index = args.indexOf("--days");
  const raw = index >= 0 ? args[index + 1] : "30";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new Error("--days must be an integer from 1 to 365");
  }
  return value;
}

function printReport(rows: TextMetricAggregate[], days: number, since: string): void {
  const events: TextMetricEvent[] = [
    "screen_opened",
    "open_or_create",
    "first_publish",
    "second_device",
    "text_copied",
    "client_error",
  ];
  const totals = new Map<TextMetricEvent, number>(events.map((event) => [event, 0]));
  for (const row of rows) {
    totals.set(row.event, (totals.get(row.event) ?? 0) + Number(row.count));
  }

  const visits = totals.get("screen_opened") ?? 0;
  console.log(`QuickDrop text funnel — last ${days} day(s), since ${since} UTC`);
  console.log("Aggregated counters only; no codes, PINs, content, IPs, user agents, or client identifiers.\n");
  console.log("Event             Count   % of screen opens");
  console.log("----------------  ------  -----------------");
  for (const event of events) {
    const count = totals.get(event) ?? 0;
    const conversion = visits > 0 ? `${((count / visits) * 100).toFixed(1)}%` : "—";
    console.log(`${event.padEnd(16)}  ${String(count).padStart(6)}  ${conversion.padStart(17)}`);
  }

  if (rows.length === 0) {
    console.log("\nNo aggregate metrics found. Enable collection with TEXT_METRICS_ENABLED=true.");
    return;
  }

  console.log("\nBreakdown (UTC day / event / kind / outcome / error):");
  for (const row of rows) {
    console.log([
      row.metricDate,
      row.event,
      row.roomKind,
      row.outcome,
      row.errorCategory,
      row.count.toString(),
    ].join("\t"));
  }
}
