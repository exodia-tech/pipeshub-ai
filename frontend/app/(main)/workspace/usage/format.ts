import type { Totals } from "./api";

export type UsageMetric = "tokens" | "cost" | "requests";
export function metricValue(row: Totals, metric: UsageMetric): number | null {
  if (metric === "cost")
    return row.requests > 0 && row.unpriced_requests === row.requests
      ? null
      : row.cost_usd;
  if (metric === "requests") return row.requests;
  return row.requests > 0 && row.unknown_requests === row.requests
    ? null
    : row.input_tokens + row.output_tokens;
}

export function chartMaximum(rows: Totals[], metric: UsageMetric): number {
  return Math.max(0, ...rows.map((row) => metricValue(row, metric) ?? 0));
}

export function seriesSegments(rows: Totals[], metric: UsageMetric) {
  const segments: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  rows.forEach((row, index) => {
    const value = metricValue(row, metric);
    if (value === null) current = [];
    else {
      if (!current.length) segments.push(current);
      current.push({ index, value });
    }
  });
  return segments;
}

export function exclusiveEnd(date: string): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid date");
  return new Date(timestamp + 86_400_000).toISOString();
}

export function money(value: number | null, locale: string): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 9 : 4,
  }).format(value);
}
