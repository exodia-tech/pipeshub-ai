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
import AccessGroupsPage from "../access-groups-page";
import { AccessGroupsApi } from "../access-api";
import { UsersApi } from "../../users/api";

const state = vi.hoisted(() => ({ admin: true, sessionActive: true }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/store/user-store", () => ({
  selectIsAdmin: (s: { admin: boolean }) => s.admin,
  useUserStore: (selector: (s: { admin: boolean }) => boolean) =>
    selector(state),
}));
vi.mock("@/lib/api/session-cache", () => ({
  onSessionEnd: () => () => {},
  captureSession: () => () => state.sessionActive,
}));
vi.mock("../access-api", () => ({
  AccessGroupsApi: {
    list: vi.fn(),
    create: vi.fn(),
    members: vi.fn(),
    changeMembers: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    policy: vi.fn(async () => ({ defaultAllow: true, rules: [] })),
    resources: vi.fn(async () => ({
      nodes: [
        {
          ref: "apps/slack",
          name: "Slack",
          kind: "connector",
          allowed: true,
          navigable: true,
          explicit: null,
          readableMembers: 1,
        },
      ],
      memberCount: 1,
      hasMore: false,
    })),
    savePolicy: vi.fn(),
    scopes: vi.fn(async () => [{ name: 'agent:read', description: 'Read agents', category: 'Agents' }, { name: 'agent:execute', description: 'Execute agents', category: 'Agents' }]),
  },
}));
vi.mock("../../users/api", () => ({
  UsersApi: {
    fetchMergedUsers: vi.fn().mockResolvedValue({ users: [], totalCount: 0 }),
  },
}));

function show() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Theme>
        <AccessGroupsPage />
      </Theme>
    </SWRConfig>,
  );
}
describe("access groups", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    state.admin = true;
    state.sessionActive = true;
    vi.mocked(AccessGroupsApi.list).mockResolvedValue([
      { _key: "g1", name: "Finance" },
    ]);
    vi.mocked(AccessGroupsApi.members).mockResolvedValue([
      { userId: "u1", userName: "Ada" },
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
  it("restricts group administration to admins", () => {
    state.admin = false;
    show();
    expect(AccessGroupsApi.list).not.toHaveBeenCalled();
  });
  it("saves native feature scopes while preserving content restrictions and revision", async () => {
    vi.mocked(AccessGroupsApi.policy).mockResolvedValue({ defaultAllow: false, revision: 4,
      rules: [{ ref: 'apps/slack', allow: true }], featureScopes: null });
    show();
    fireEvent.click(await screen.findByText('Finance'));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'groupScopes.title' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('button', { name: 'workspace.groups.actions.managePermissions' }));
    fireEvent.click(screen.getByRole('switch', { name: 'groupScopes.limit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'agent:execute', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(AccessGroupsApi.savePolicy).toHaveBeenCalledWith('g1', {
      defaultAllow: false, revision: 4, rules: [{ ref: 'apps/slack', allow: true }], featureScopes: ['agent:read'],
    }));
  });
  it("keeps failed feature edits reviewable and cancels them without changing the policy", async () => {
    vi.mocked(AccessGroupsApi.policy).mockResolvedValue({ defaultAllow: true, revision: 7, rules: [], featureScopes: null });
    vi.mocked(AccessGroupsApi.savePolicy).mockRejectedValueOnce(new Error('Another administrator changed this policy. Reload it before saving.'));
    show();
    fireEvent.click(await screen.findByText('Finance'));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'groupScopes.title' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('button', { name: 'workspace.groups.actions.managePermissions' }));
    fireEvent.click(screen.getByRole('switch', { name: 'groupScopes.limit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'agent:execute', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('Another administrator changed this policy. Reload it before saving.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'agent:execute', exact: true }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(screen.getByRole('switch', { name: 'groupScopes.limit' }).getAttribute('aria-checked')).toBe('false');
    expect(AccessGroupsApi.savePolicy).toHaveBeenCalledTimes(1);
  });
  it("shows group metadata in the table and cancels description changes", async () => {
    vi.mocked(AccessGroupsApi.list).mockResolvedValue([{
      _key: "g1", name: "Finance", description: "Finance reference material",
      createdAtTimestamp: 1794528000000,
      createdByUser: { userId: "creator", name: "Alex Example", email: "alex@example.invalid" },
    }]);
    show();
    expect(await screen.findByText("Finance reference material")).toBeTruthy();
    expect(screen.getByText("workspace.groups.columns.description")).toBeTruthy();
    expect(screen.getByText("workspace.groups.columns.createdBy")).toBeTruthy();
    expect(screen.getByText("workspace.groups.columns.createdOn")).toBeTruthy();
    expect(screen.getByText("Alex Example")).toBeTruthy();
    fireEvent.click(screen.getByText("Finance"));
    const description = screen.getByLabelText("workspace.groups.detail.descriptionLabel");
    expect(description).toHaveProperty("readOnly", true);
    await waitFor(() => expect(screen.getByRole("button", { name: "workspace.groups.edit.edit" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "workspace.groups.edit.edit" }));
    fireEvent.change(description, { target: { value: "Draft purpose" } });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(description).toHaveProperty("value", "Finance reference material");
    expect(AccessGroupsApi.rename).not.toHaveBeenCalled();
  });
  it("opens a read-only access group and cancels name edits without saving", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    expect(screen.getByLabelText("accessGroups.name")).toHaveProperty(
      "readOnly",
      true,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.change(screen.getByLabelText("accessGroups.name"), {
      target: { value: "Draft name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.getByLabelText("accessGroups.name")).toHaveProperty(
      "value",
      "Finance",
    );
    expect(AccessGroupsApi.rename).not.toHaveBeenCalled();
  });
  it("saves a group description without changing its membership", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await waitFor(() => expect(screen.getByRole("button", { name: "workspace.groups.edit.edit" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "workspace.groups.edit.edit" }));
    const description = screen.getByLabelText("workspace.groups.detail.descriptionLabel");
    expect(description).toHaveProperty("maxLength", 2000);
    fireEvent.change(description, { target: { value: "Budget reference material" } });
    fireEvent.click(screen.getByRole("button", { name: "workspace.groups.edit.save" }));
    await waitFor(() => expect(AccessGroupsApi.rename).toHaveBeenCalledWith("g1", "Finance", "Budget reference material"));
    expect(AccessGroupsApi.changeMembers).not.toHaveBeenCalled();
  });
  it("shows the members of the selected group and removes one", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    expect(await screen.findByText("Ada")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.remove" }),
    );
    expect(AccessGroupsApi.changeMembers).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(AccessGroupsApi.changeMembers).toHaveBeenCalledWith(
        "g1",
        "remove",
        ["u1"],
      ),
    );
  });
  it("creates a group using its entered name", async () => {
    vi.mocked(AccessGroupsApi.create).mockResolvedValue("new-group");
    show();
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.create" }),
    );
    fireEvent.change(screen.getByLabelText("accessGroups.name"), {
      target: { value: "Research" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "accessGroups.create" }).at(-1)!,
    );
    await waitFor(() =>
      expect(AccessGroupsApi.create).toHaveBeenCalledWith("Research", undefined),
    );
  });
  it("starts a fresh description after cancelling group creation", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.create" }));
    fireEvent.change(screen.getByLabelText("workspace.groups.create.descriptionLabel", { exact: false }), { target: { value: "Cancelled purpose" } });
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.create" }));
    expect(screen.getByLabelText("workspace.groups.create.descriptionLabel", { exact: false })).toHaveProperty("value", "");
  });
  it("finds an active person and adds them to the group", async () => {
    vi.mocked(UsersApi.fetchMergedUsers).mockResolvedValue({
      users: [
        {
          id: "graph-id",
          userId: "mongo-id",
          name: "Nina",
          email: "nina@example.invalid",
          isActive: true,
          hasLoggedIn: true,
          profilePicture: null,
        },
      ],
      totalCount: 1,
    });
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.click(
      await screen.findByText("workspace.groups.edit.addUsersPlaceholder"),
    );
    fireEvent.click(await screen.findByText("Nina"));
    fireEvent.keyDown(
      screen.getByRole("textbox", {
        name: "workspace.groups.edit.addUsersPlaceholder",
      }),
      { key: "Escape" },
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(AccessGroupsApi.changeMembers).toHaveBeenCalledWith("g1", "add", [
        "mongo-id",
      ]),
    );
  });
  it("renames a selected group and confirms deletion", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.change(screen.getByLabelText("accessGroups.name"), {
      target: { value: "New name" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(AccessGroupsApi.rename).toHaveBeenCalledWith("g1", "New name", undefined),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "accessGroups.delete" }),
      ).not.toHaveProperty("disabled", true),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.delete" }),
    );
    expect(AccessGroupsApi.delete).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("alertdialog").querySelector("button:last-child")!,
    );
    await waitFor(() =>
      expect(AccessGroupsApi.delete).toHaveBeenCalledWith("g1"),
    );
  });
  it("uses the shared pager and probes for another page without inventing a total", async () => {
    const groups = Array.from({ length: 101 }, (_, index) => ({
      _key: `g${index}`,
      name: `Group ${index + 1}`,
    }));
    vi.mocked(AccessGroupsApi.list).mockImplementation(
      async (skip = 0, limit = 100) => groups.slice(skip, skip + limit),
    );
    show();
    await screen.findByText("Group 1");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.pagination.next" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.next" }),
    );
    await screen.findByText("Group 101");
    expect(AccessGroupsApi.list).toHaveBeenCalledWith(100, 100);
    expect(
      screen.getByRole("button", { name: "workspace.pagination.next" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.previous" }),
    );
    await screen.findByText("Group 1");
    expect(AccessGroupsApi.list).toHaveBeenCalledWith(0, 100);
  });

  it("keeps the previous group page available after a page request fails", async () => {
    const groups = Array.from({ length: 101 }, (_, index) => ({
      _key: `g${index}`,
      name: `Group ${index + 1}`,
    }));
    vi.mocked(AccessGroupsApi.list).mockImplementation(
      async (skip = 0, limit = 100) => {
        if (skip === 100 && limit === 100)
          throw new Error("Fixture page failure");
        return groups.slice(skip, skip + limit);
      },
    );
    show();
    await screen.findByText("Group 1");
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.next" }),
    );
    await screen.findByText("accessGroups.error");
    expect(
      screen.getByRole("button", { name: "workspace.pagination.previous" }),
    ).toHaveProperty("disabled", false);
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.pagination.previous" }),
    );
    await screen.findByText("Group 1");
  });

  it("saves more than 500 removals in bounded requests and retries only an unconfirmed batch", async () => {
    const members = Array.from({ length: 501 }, (_, index) => ({
      userId: `member-${index}`,
      userName: `Batch member ${index}`,
    }));
    vi.mocked(AccessGroupsApi.members).mockResolvedValue(members);
    vi.mocked(AccessGroupsApi.changeMembers)
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Second batch failed"));
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await screen.findByText("Batch member 0");
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    for (let index = 25; index < 501; index += 25) {
      fireEvent.scroll(
        screen.getByRole("region", {
          name: "workspace.groups.detail.searchUsers",
        }),
      );
      await screen.findByText(`Batch member ${Math.min(index + 24, 500)}`);
    }
    act(() => {
      for (const button of screen.getAllByRole("button", {
        name: "accessGroups.remove",
      }))
        fireEvent.click(button);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(
        vi.mocked(AccessGroupsApi.changeMembers).mock.calls[0]?.[2].length,
      ).toBe(500),
    );
    await screen.findAllByText("accessGroups.error");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.save" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(AccessGroupsApi.changeMembers).toHaveBeenCalledTimes(3),
    );
    expect(
      vi
        .mocked(AccessGroupsApi.changeMembers)
        .mock.calls.map((call) => call[2].length),
    ).toEqual([500, 1, 1]);
    expect(vi.mocked(AccessGroupsApi.changeMembers).mock.calls[2][2]).toEqual([
      "member-500",
    ]);
  }, 30000);

  it("does not replay a confirmed removal when a later addition fails", async () => {
    vi.mocked(UsersApi.fetchMergedUsers).mockResolvedValue({
      users: [
        {
          id: "u2",
          userId: "u2",
          name: "Nina",
          email: "nina@example.invalid",
          isActive: true,
          hasLoggedIn: true,
          profilePicture: null,
        },
      ],
      totalCount: 1,
    });
    vi.mocked(AccessGroupsApi.changeMembers).mockImplementation(
      async (_group, operation) => {
        if (operation === "remove")
          vi.mocked(AccessGroupsApi.members).mockResolvedValue([]);
        else throw new Error("Fixture addition failure");
      },
    );
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await screen.findByText("Ada");
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.remove" }),
    );
    fireEvent.click(
      screen.getByText("workspace.groups.edit.addUsersPlaceholder"),
    );
    fireEvent.click(await screen.findByText("Nina"));
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await screen.findAllByText("accessGroups.error");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "workspace.groups.edit.save" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() =>
      expect(AccessGroupsApi.changeMembers).toHaveBeenCalledTimes(3),
    );
    expect(
      vi
        .mocked(AccessGroupsApi.changeMembers)
        .mock.calls.map((call) => call[1]),
    ).toEqual(["remove", "add", "add"]);
  });
  it("stops the remaining save operations when the session ends", async () => {
    let finish: () => void = () => {};
    vi.mocked(AccessGroupsApi.rename).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    show();
    fireEvent.click(await screen.findByText("Finance"));
    await screen.findByText("Ada");
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.edit" }),
    );
    fireEvent.change(screen.getByLabelText("accessGroups.name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.remove" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.groups.edit.save" }),
    );
    await waitFor(() => expect(AccessGroupsApi.rename).toHaveBeenCalled());
    state.sessionActive = false;
    await act(async () => {
      finish();
    });
    expect(AccessGroupsApi.changeMembers).not.toHaveBeenCalled();
  });

  it("keeps unsaved access rules until the admin explicitly discards them", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    fireEvent.mouseDown(
      screen.getByRole("tab", {
        name: /groupScopes.content/,
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "groupAccess.allow Slack" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.profile.discardCancel" }),
    );
    expect(
      screen.getByRole("button", { name: "workspace.groups.permissions.save" }),
    ).toBeTruthy();
    expect(AccessGroupsApi.savePolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "workspace.profile.discardConfirm",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
  });
});
