import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import locale from "@/lib/i18n/locales/en-US.json";
import UsagePage from "../page";
import type { UsageReport } from "../api";

const fixture: { admin: boolean; report: UsageReport | null } = vi.hoisted(
  () => ({ admin: false, report: null }),
);
const translations: Record<string, string> = locale.usage;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key.split(".").pop() ?? ""] ?? key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/lib/store/user-store", () => ({
  selectIsAdmin: (state: { admin: boolean }) => state.admin,
  useUserStore: (select: (state: { admin: boolean }) => boolean) =>
    select(fixture),
}));
vi.mock("@/lib/api/session-cache", () => ({ onSessionEnd: () => () => {} }));
vi.mock("@/app/components/ui/MaterialIcon", () => ({
  MaterialIcon: () => null,
}));
vi.mock("../../connectors/api", () => ({
  ConnectorsApi: { getActiveConnectors: vi.fn() },
}));
vi.mock("../api", () => ({
  usageApi: {
    report: vi.fn(),
    budgets: vi.fn(),
    rates: vi.fn(),
    saveRate: vi.fn(),
    saveBudget: vi.fn(),
    deleteBudget: vi.fn(),
  },
}));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data:
      Array.isArray(key) && key[0] === "usage-report"
        ? fixture.report
        : undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

describe("usage dashboard", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    fixture.admin = false;
    fixture.report = {
      summary: {
        requests: 1,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 0,
        unpriced_requests: 1,
        estimated_requests: 0,
        unknown_requests: 1,
        incomplete_requests: 0,
        average_duration_ms: 20,
        units: 1,
      },
      timeline: [],
      model: [],
      provider: [],
      user_id: [],
      connector_id: [],
      workload: [],
      kind: [],
      status: [],
      events: [
        {
          id: "demo",
          occurred_at: "2026-11-07T12:00:00Z",
          provider: "custom",
          model: "test-model",
          user_id: "member-a",
          user_label: "Alice",
          connector_id: null,
          workload: "chat",
          purpose: "main",
          kind: "completion",
          status: "success",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          measurement: "unknown",
          cost_usd: null,
          pricing_source: "unpriced",
          duration_ms: 20,
          units: 1,
        },
      ],
      tracking_since: "2026-11-07T12:00:00Z",
      tracking_health: {
        enabled: true,
        failed: 0,
        written: 1,
        missing_identity: 0,
        scope: "this_process",
      },
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const show = () =>
    render(
      <Theme appearance="light">
        <UsagePage />
      </Theme>,
    );
  it("does not present entirely unpriced activity as free", () => {
    show();
    expect(
      screen.getByRole("heading", { name: "—", exact: true }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "$0.00", exact: true }),
    ).toBeNull();
  });
  it("keeps personal view free of member filters and administrator pricing controls", () => {
    show();
    expect(
      screen.queryByRole("combobox", { name: "Member", exact: true }),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: /^Model pricing/ })).toBeNull();
  });
  it("shows unknown counters distinctly in call history", () => {
    show();
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Call history/ }), {
      key: "Enter",
    });
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
  });
  it("exposes pricing management to administrators", () => {
    fixture.admin = true;
    show();
    expect(screen.getByRole("tab", { name: /^Model pricing/ })).toBeTruthy();
  });
});
