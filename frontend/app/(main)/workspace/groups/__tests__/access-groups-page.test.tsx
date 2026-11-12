import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
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

const state = vi.hoisted(() => ({ admin: true }));
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
  captureSession: () => () => true,
}));
vi.mock("../access-api", () => ({
  AccessGroupsApi: {
    list: vi.fn(),
    create: vi.fn(),
    members: vi.fn(),
    changeMembers: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    policy: vi.fn(async()=>({defaultAllow:true,rules:[]})),
    resources: vi.fn(async()=>({nodes:[{ref:"apps/slack",name:"Slack",kind:"connector",allowed:true,navigable:true,explicit:null,readableMembers:1}],memberCount:1,hasMore:false})),
    savePolicy: vi.fn(),
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
  it("shows the members of the selected group and removes one", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    expect(await screen.findByText("Ada")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "accessGroups.remove" }),
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
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.create" }));
    fireEvent.change(screen.getByLabelText("accessGroups.name"), {
      target: { value: "Research" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "accessGroups.create" }).at(-1)! ,
    );
    await waitFor(() =>
      expect(AccessGroupsApi.create).toHaveBeenCalledWith("Research"),
    );
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
    fireEvent.click(await screen.findByText("workspace.teams.edit.addUsersLabel"));
    fireEvent.click(await screen.findByText("Nina"));
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.add" }));
    await waitFor(() =>
      expect(AccessGroupsApi.changeMembers).toHaveBeenCalledWith("g1", "add", [
        "mongo-id",
      ]),
    );
  });
  it("renames a selected group and confirms deletion", async () => {
    show();
    fireEvent.click(await screen.findByText("Finance"));
    fireEvent.change(screen.getByLabelText("accessGroups.name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.rename" }));
    await waitFor(() => expect(AccessGroupsApi.rename).toHaveBeenCalledWith("g1", "New name"));
    await waitFor(() => expect(screen.getByRole("button", { name: "accessGroups.delete" })).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "accessGroups.delete" }));
    expect(AccessGroupsApi.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("alertdialog").querySelector('button:last-child')!);
    await waitFor(() => expect(AccessGroupsApi.delete).toHaveBeenCalledWith("g1"));
  });
  it("keeps unsaved access rules until the admin explicitly discards them",async()=>{
    show();
    fireEvent.click(await screen.findByText("Finance"));
    fireEvent.mouseDown(screen.getByRole("tab",{name:/workspace.groups.detail.accessPermissions/}),{button:0,ctrlKey:false});
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(await screen.findByRole("checkbox",{name:"groupAccess.allow Slack"}));
    fireEvent.click(screen.getByRole("button",{name:"common.close"}));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"workspace.profile.discardCancel"}));
    expect(screen.getByRole("button",{name:"workspace.groups.permissions.save"})).toBeTruthy();
    expect(AccessGroupsApi.savePolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"common.close"}));
    fireEvent.click(await screen.findByRole("button",{name:"workspace.profile.discardConfirm"}));
    await waitFor(()=>expect(screen.queryByRole("switch")).toBeNull());
  });
});
