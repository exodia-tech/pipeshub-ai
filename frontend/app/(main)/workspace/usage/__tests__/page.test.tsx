import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import locale from "@/lib/i18n/locales/en-US.json";
import UsagePage from "../page";
import { usageApi, type UsageReport } from "../api";

const fixture: {
  admin: boolean;
  report: UsageReport | null;
  params?: Record<string, unknown>;
} = vi.hoisted(() => ({ admin: false, report: null }));
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
  default: (key: unknown) => {
    if (Array.isArray(key) && key[0] === "usage-report")
      fixture.params = key[1];
    return {
      data:
        Array.isArray(key) && key[0] === "usage-report"
          ? fixture.report
          : undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

describe("usage dashboard", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
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
      screen.getAllByRole("heading", { name: "—", exact: true })[0],
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
  it("shows an admin the audience and member controls without opening advanced filters", async () => {
    fixture.admin = true;
    show();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "View", exact: true }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Organization", exact: true }),
    );
    expect(
      screen.getByRole("combobox", { name: "Consumption", exact: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Member", exact: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("table", { name: "Usage by member", exact: true }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Filters" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Consumption", exact: true }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "All users", exact: true }),
    );
    expect(fixture.params?.audience).toBe("users");
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Consumption", exact: true }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Background services",
        exact: true,
      }),
    );
    expect(fixture.params?.audience).toBe("services");
    expect(
      screen.queryByRole("combobox", { name: "Member", exact: true }),
    ).toBeNull();
  });
  it("keeps secondary filters collapsed and makes chart values accessible without an extra dropdown", () => {
    fixture.report!.timeline = [
      {
        ...fixture.report!.summary,
        id: "day",
        label: "2026-11-07",
        unpriced_requests: 0,
        unknown_requests: 0,
      },
    ];
    show();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
    fireEvent.click(filters);
    expect(filters.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Usage over time" })).toBeTruthy();
    expect(screen.queryByText("View chart data")).toBeNull();
  });
  it("lets an administrator create an organization budget from the default view", async () => {
    fixture.admin = true;
    vi.mocked(usageApi.saveBudget).mockResolvedValue({} as never);
    show();
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Budgets/ }), {
      key: "Enter",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /set monthly budget/i }),
    );
    fireEvent.change(screen.getByLabelText("Monthly limit (USD)"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(usageApi.saveBudget).toHaveBeenCalledWith({
        scope: "organization",
        subject: "",
        amount_usd: "20",
        warning_percent: 80,
      }),
    );
  });
  it("shows an error when saving a budget fails", async () => {
    fixture.admin = true;
    vi.mocked(usageApi.saveBudget).mockRejectedValueOnce(new Error("offline"));
    show();
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Budgets/ }), {
      key: "Enter",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /set monthly budget/i }),
    );
    fireEvent.change(screen.getByLabelText("Monthly limit (USD)"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save changes.")).toBeTruthy();
  });
  it("shows no-data charts when there was no activity", () => {
    fixture.report!.summary.requests = 0;
    fixture.report!.summary.unpriced_requests = 0;
    fixture.report!.summary.unknown_requests = 0;
    show();
    expect(screen.queryByRole("img", { name: "Usage over time" })).toBeNull();
    expect(screen.getAllByText(translations.noData).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "$0.00" })).toBeTruthy();
  });
  it("shows a visible point for one known timeline value", () => {
    fixture.report!.timeline = [
      {
        ...fixture.report!.summary,
        id: "one",
        label: "2026-11-07",
        unknown_requests: 0,
        input_tokens: 100,
      },
    ];
    show();
    const chart = screen.getByRole("img", { name: "Usage over time" });
    expect(chart.querySelector("circle")).toBeTruthy();
    expect(
      screen.getByRole("table", { name: "Usage over time" }).textContent,
    ).toContain("100");
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
