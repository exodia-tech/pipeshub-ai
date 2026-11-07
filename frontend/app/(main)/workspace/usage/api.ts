import { apiClient } from "@/lib/api";

export interface Totals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number | null;
  cost_usd: number;
  unpriced_requests: number;
  estimated_requests: number;
  unknown_requests: number;
  incomplete_requests: number;
  average_duration_ms: number;
  units: number;
}
export interface Breakdown extends Totals {
  id: string | null;
  label: string;
}
export interface UsageEvent {
  id: string;
  occurred_at: string;
  provider: string;
  model: string;
  user_id: string | null;
  user_label: string | null;
  connector_id: string | null;
  workload: string;
  purpose: string;
  kind: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number | null;
  measurement: string;
  cost_usd: number | null;
  pricing_source: string;
  duration_ms: number;
  units: number;
}
export interface UsageReport {
  summary: Totals;
  timeline: Breakdown[];
  model: Breakdown[];
  provider: Breakdown[];
  user_id: Breakdown[];
  connector_id: Breakdown[];
  workload: Breakdown[];
  kind: Breakdown[];
  status: Breakdown[];
  events: UsageEvent[];
  tracking_since: string | null;
  tracking_health: {
    enabled: boolean;
    written: number;
    failed: number;
    missing_identity: number;
    scope: string;
  };
}
export interface Budget {
  id: string;
  scope: string;
  subject: string;
  amount_usd: number;
  spent_usd: number;
  percent: number;
  warning_percent: number;
  state: string;
  unpriced_requests: number;
  period_start: string;
  period_end: string;
  enforced: false;
}
export interface Rate {
  provider: string;
  model: string;
  rates: Record<"input" | "output" | "cache_read" | "cache_write", string>;
  updated_at?: string;
}
export const usageApi = {
  report: async (params: Record<string, string | number>) =>
    (await apiClient.get<UsageReport>("/api/v1/usage", { params })).data,
  budgets: async (view: string) =>
    (
      await apiClient.get<{ budgets: Budget[] }>("/api/v1/usage/budgets", {
        params: { view },
      })
    ).data,
  rates: async () =>
    (await apiClient.get<{ rates: Rate[] }>("/api/v1/usage/rates")).data,
  saveRate: async ({ provider, model, rates }: Rate) =>
    apiClient.put("/api/v1/usage/rates", { provider, model, rates }),
  resetRate: async (provider: string, model: string) =>
    apiClient.delete("/api/v1/usage/rates", { data: { provider, model } }),
  saveBudget: async (body: {
    scope: string;
    subject: string;
    amount_usd: string;
    warning_percent: number;
  }) => apiClient.put("/api/v1/usage/budgets", body),
  deleteBudget: async (id: string) =>
    apiClient.delete(`/api/v1/usage/budgets/${encodeURIComponent(id)}`),
};
