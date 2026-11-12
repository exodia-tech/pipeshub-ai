import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { Theme } from "@radix-ui/themes";
import { GroupAccessPanel } from "../group-access-panel";
import { AccessGroupsApi } from "../access-api";

vi.mock("react-i18next", () => ({useTranslation: () => ({t:(key:string)=>key})}));
vi.mock("@/lib/api/session-cache", () => ({onSessionEnd:()=>()=>{},captureSession:()=>()=>true}));
vi.mock("../access-api",()=>({AccessGroupsApi:{policy:vi.fn(),resources:vi.fn(),savePolicy:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe("group resource controls",()=>{
  it("expands a connector and saves a record restriction only after Save",async()=>{
    vi.mocked(AccessGroupsApi.policy).mockResolvedValue({defaultAllow:true,rules:[]});
    vi.mocked(AccessGroupsApi.resources).mockImplementation(async(_id,parent)=>({nodes:parent ? [{ref:"records/report",name:"Report.txt",kind:"record",allowed:true,navigable:true,explicit:null,readableMembers:1}] : [{ref:"apps/slack",name:"Slack",kind:"connector",allowed:true,navigable:true,explicit:null,readableMembers:1}],hasMore:false,memberCount:1}));
    render(<SWRConfig value={{provider:()=>new Map(),dedupingInterval:0}}><Theme><GroupAccessPanel groupId="finance" /></Theme></SWRConfig>);
    fireEvent.click(await screen.findByRole("button",{name:"groupAccess.expand Slack"}));
    expect(await screen.findByText("Report.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("checkbox",{name:"groupAccess.allow Report.txt"}));
    expect(AccessGroupsApi.savePolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"workspace.groups.permissions.save"}));
    await waitFor(()=>expect(AccessGroupsApi.savePolicy).toHaveBeenCalledWith("finance",{defaultAllow:true,rules:[{ref:"records/report",allow:false}]}));
  });
  it("shows mixed connector access and selecting it replaces descendant exceptions",async()=>{
    vi.mocked(AccessGroupsApi.policy).mockResolvedValue({defaultAllow:true,rules:[{ref:"records/report",allow:false}]});
    vi.mocked(AccessGroupsApi.resources).mockResolvedValue({nodes:[{ref:"apps/slack",name:"Slack",kind:"connector",allowed:true,navigable:true,explicit:null,readableMembers:1,descendantRuleRefs:["records/report"]}],hasMore:false,memberCount:1});
    render(<SWRConfig value={{provider:()=>new Map(),dedupingInterval:0}}><Theme><GroupAccessPanel groupId="finance" /></Theme></SWRConfig>);
    expect(await screen.findByText("groupAccess.allWithExceptions")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    const checkbox=await screen.findByRole("checkbox",{name:"groupAccess.allow Slack"});
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button",{name:"workspace.groups.permissions.save"}));
    await waitFor(()=>expect(AccessGroupsApi.savePolicy).toHaveBeenCalledWith("finance",{defaultAllow:true,rules:[{ref:"apps/slack",allow:true}]}));
  });
});
