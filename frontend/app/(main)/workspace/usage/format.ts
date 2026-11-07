import type { Totals } from "./api";

export type UsageMetric = "tokens" | "cost" | "requests";
export const metricValue = (row: Totals, metric: UsageMetric): number =>
  metric === "cost"
    ? row.cost_usd
    : metric === "requests"
      ? row.requests
      : row.input_tokens + row.output_tokens;

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
    maximumFractionDigits: value > 0 && value < 0.01 ? 8 : 4,
  }).format(value);
}
