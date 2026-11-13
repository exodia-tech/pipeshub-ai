import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { Theme } from "@radix-ui/themes";
import AuditPage from "../page";
import { auditApi } from "../api";

const state = vi.hoisted(() => ({ admin: false, sessionActive: true }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: { value?: number }) =>
      key === "common.pagination.perPage" ? `${options?.value} per page` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/lib/store/user-store", () => ({
  selectIsAdmin: (value: { admin: boolean }) => value.admin,
  useUserStore: (select: (value: { admin: boolean }) => boolean) =>
    select(state),
}));
vi.mock("@/lib/api/session-cache", () => ({
  resetStoreOnSessionEnd: () => {},
  onSessionEnd: () => () => {},
  captureSession: () => () => state.sessionActive,
}));
vi.mock("../api", () => ({ auditApi: { list: vi.fn() } }));
vi.mock("../../groups/access-api", () => ({
  AccessGroupsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../../users/api", () => ({
  UsersApi: {
    getUsersByIds: vi.fn(async () => []),
    fetchMergedUsers: vi.fn(async () => ({ users: [], totalCount: 0 })),
  },
}));

const showPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Theme>
        <AuditPage />
      </Theme>
    </SWRConfig>,
  );

describe("audit history", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    state.admin = false;
    state.sessionActive = true;
    vi.mocked(auditApi.list).mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not request audit history for a non-admin", () => {
    showPage();
    expect(auditApi.list).not.toHaveBeenCalled();
    expect(screen.getByText("audit.adminOnly")).toBeTruthy();
  });

  it("reports malformed audit responses instead of crashing", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({} as never);
    showPage();
    expect(await screen.findByText("audit.error")).toBeTruthy();
  });

  it("shows events and uses the server cursor for the next page", async () => {
    state.admin = true;
    vi.mocked(auditApi.list)
      .mockResolvedValueOnce({
        events: [
          {
            id: "first",
            operation_id: "op",
            actor_id: "actor-a",
            action: "group.create",
            outcome: "success",
            group_ids: ["group-a"],
            member_ids: ["member-a"],
            recorded_at: "2026-11-08T12:00:00.000Z",
          },
        ],
        next_cursor: "next-page",
      })
      .mockResolvedValueOnce({ events: [], next_cursor: null });
    showPage();
    expect(await screen.findByText("actor-a")).toBeTruthy();
    fireEvent.click(screen.getByText("actor-a"));
    expect(await screen.findByText("member-a")).toBeTruthy();
    expect(screen.getByText("op")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.next" }),
    );
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "next-page" }),
      ),
    );
  });

  it("resets cursor history when page size changes without changing the active filters", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [
        {
          id: "paging",
          operation_id: "op",
          actor_id: "actor-a",
          action: "audit.read",
          outcome: "success",
          group_ids: [],
          member_ids: [],
          recorded_at: "2026-11-08T12:00:00Z",
        },
      ],
      next_cursor: "next-page",
    });
    showPage();
    await screen.findByText("actor-a");
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.next" }),
    );
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "next-page", limit: "50" }),
      ),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "50 per page" }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "10 per page" }),
    );
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: "10" }),
      ),
    );
    expect(vi.mocked(auditApi.list).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "cursor",
    );
    expect(
      screen.getByRole("button", { name: "workspace.pagination.previous" }),
    ).toHaveProperty("disabled", true);
  });

  it("shows agent and tool correlation in the existing event details", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [
        {
          id: "agent-event",
          operation_id: "event-1",
          actor_id: "actor-a",
          action: "agent.tool",
          outcome: "failed",
          group_ids: [],
          member_ids: [],
          recorded_at: "2026-11-08T12:00:00.000Z",
          agent_event: {
            agent_id: "agent-1",
            run_id: "run-1",
            trace_id: "trace-1",
            parent_run_id: "parent-1",
            tool_name: "mcp_drive_read",
            tool_call_id: "call-1",
            model: "fixture-model",
          },
        },
      ],
      next_cursor: null,
    });
    showPage();
    fireEvent.click(await screen.findByText("actor-a"));
    for (const value of [
      "agent-1",
      "run-1",
      "trace-1",
      "parent-1",
      "mcp_drive_read",
      "call-1",
      "fixture-model",
    ])
      expect(await screen.findByText(value)).toBeTruthy();
  });
  it("filters the selected UTC day as an inclusive start and exclusive end", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [],
      next_cursor: null,
    });
    showPage();
    await screen.findByText("audit.empty");
    fireEvent.click(
      screen.getByRole("button", { name: "audit.from", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Sunday, November 8, 2026" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "datePicker.apply" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "datePicker.apply" }),
      ).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "audit.to", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Sunday, November 8, 2026" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "datePicker.apply" }));
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: "2026-11-08T00:00:00.000Z",
          to: "2026-11-09T00:00:00.000Z",
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "common.clear audit.from" }),
    );
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ from: expect.anything() }),
      ),
    );
  });
  it("keeps coverage behind a focusable help icon instead of a disclosure", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [],
      next_cursor: null,
    });
    showPage();
    await screen.findByText("audit.empty");
    expect(
      screen.getByRole("button", { name: "audit.coverageTitle" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "audit.coverageTitle" }),
    );
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "audit.loginWarning",
    );
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });
  it("does not request history with an invalid resource filter", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [],
      next_cursor: null,
    });
    showPage();
    await screen.findByText("audit.empty");
    vi.mocked(auditApi.list).mockClear();
    fireEvent.change(screen.getByPlaceholderText("audit.resource"), {
      target: { value: "invalid/resource" },
    });
    expect(screen.getByText("audit.invalidFilters")).toBeTruthy();
    expect(auditApi.list).not.toHaveBeenCalled();
  });

  it("requests a separately audited export before downloading the current page", async () => {
    state.admin = true;
    vi.mocked(auditApi.list).mockResolvedValue({
      events: [
        {
          id: "1",
          operation_id: "op",
          actor_id: "actor",
          action: "group.create",
          outcome: "success",
          group_ids: [],
          member_ids: [],
          recorded_at: "2026-11-08T12:00:00.000Z",
        },
      ],
      next_cursor: null,
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    showPage();
    await screen.findByText("actor");
    fireEvent.click(screen.getByRole("button", { name: "audit.exportPage" }));
    await waitFor(() =>
      expect(auditApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ export: "true" }),
      ),
    );
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not download an export that finishes after the session ends", async () => {
    state.admin = true;
    const page = {
      events: [
        {
          id: "1",
          operation_id: "op",
          actor_id: "actor",
          action: "group.create",
          outcome: "success",
          group_ids: [],
          member_ids: [],
          recorded_at: "2026-11-08T12:00:00.000Z",
        },
      ],
      next_cursor: null,
    };
    let finish: (value: typeof page) => void = () => {};
    vi.mocked(auditApi.list)
      .mockResolvedValueOnce(page)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    showPage();
    await screen.findByText("actor");
    fireEvent.click(screen.getByRole("button", { name: "audit.exportPage" }));
    state.sessionActive = false;
    await act(async () => finish(page));
    await waitFor(() => expect(auditApi.list).toHaveBeenCalledTimes(2));
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
