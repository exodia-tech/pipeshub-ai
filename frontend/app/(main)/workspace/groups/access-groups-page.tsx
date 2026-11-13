"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import {
  Box,
  Button,
  Callout,
  Flex,
  Badge,
  Text,
  IconButton,
  Tabs,
} from "@radix-ui/themes";
import { pagePaddingX } from "@/app/components/ui/responsive";
import { HelpTooltip } from "@/app/components/ui/help-tooltip";
import { MaterialIcon } from "@/app/components/ui/MaterialIcon";
import { captureSession, onSessionEnd } from "@/lib/api/session-cache";
import { selectIsAdmin, useUserStore } from "@/lib/store/user-store";
import {
  AvatarCell,
  EntityDataTable,
  EntityPageHeader,
  EntityPagination,
  EntityRowActionMenu,
  FormField,
  EntityDescriptionInput,
  EntityMemberRow,
  PaginatedMembersList,
  WorkspaceRightPanel,
  SearchableCheckboxDropdown,
} from "../components";
import { PAGE_PADDING_TOP } from "../components/settings-page-container";
import { usePaginatedUserOptions } from "../hooks/use-paginated-user-options";
import { GroupAccessPanel } from "./group-access-panel";
import { AccessGroupsApi, type AccessGroup } from "./access-api";
import { GroupNameInput } from "./components/group-name-input";
import { formatDate } from "@/lib/utils/formatters";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { useWorkspaceDrawerNestedModalHost } from "../components/workspace-right-panel";

// The existing membership API accepts at most 500 IDs per request.
const MEMBER_BATCH_LIMIT = 500;

export default function AccessGroupsPage() {
  const { t } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const profile = useUserStore((state) => state.profile);
  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(100);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [renameName, setRenameName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [pendingMembers, setPendingMembers] = useState<string[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState("members");
  const [accessDirty, setAccessDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(
    null,
  );
  const deleteDialogHost = useWorkspaceDrawerNestedModalHost(
    confirmDelete || pendingNavigation !== null,
  );
  const {
    data: groupPage,
    error,
    mutate,
    isLoading: groupsLoading,
  } = useSWR(isAdmin ? ["access-groups", skip, limit] : null, async () => {
    const groups = await AccessGroupsApi.list(skip, limit);
    const next =
      groups.length === limit
        ? await AccessGroupsApi.list(skip + limit, 1)
        : [];
    return { groups, hasMore: next.length > 0 };
  });
  const groups = groupPage?.groups;
  const {
    data: members,
    error: memberError,
    mutate: refreshMembers,
  } = useSWR(
    isAdmin && selected ? ["access-group-members", selected] : null,
    () => AccessGroupsApi.members(selected),
  );
  const people = usePaginatedUserOptions({
    enabled: isAdmin && !!selected,
    idField: "userId",
  });
  useEffect(
    () =>
      onSessionEnd(() => {
        setSkip(0);
        setLimit(100);
        setHelpOpen(false);
        setEditing(false);
        setPendingRemovals([]);
        setSelected("");
        setCreating(false);
        setName("");
        setDescription("");
        setRenameName("");
        setEditDescription("");
        setPendingMembers([]);
        setGroupSearch("");
        setSelectedRows(new Set());
        setBusy(false);
        setFailed(false);
        setTab("members");
        setAccessDirty(false);
        setPendingNavigation(null);
        setConfirmDelete(false);
      }),
    [],
  );
  const run = async (
    work: (isCurrent: () => boolean) => Promise<unknown>,
    after: () => Promise<unknown>,
  ) => {
    if (busy) return;
    const current = captureSession();
    setBusy(true);
    setFailed(false);
    try {
      await work(current);
      if (current()) await after();
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const openGroup = (group: AccessGroup, nextTab = "members") => {
    setSelected(group._key);
    setRenameName(group.name);
    setEditDescription(group.description ?? "");
    setPendingMembers([]);
    setFailed(false);
    setTab(nextTab);
    setEditing(false);
    setPendingRemovals([]);
    setAccessDirty(false);
  };
  const selectedGroup = groups?.find((group) => group._key === selected);
  const nameDirty = editing && renameName.trim() !== selectedGroup?.name;
  const descriptionDirty = editing && editDescription.trim() !== (selectedGroup?.description ?? "");
  const memberDirty = pendingMembers.length > 0 || pendingRemovals.length > 0;
  const dirty = accessDirty || nameDirty || descriptionDirty || memberDirty;
  const resetEdits = () => {
    setEditing(false);
    setRenameName(selectedGroup?.name ?? "");
    setEditDescription(selectedGroup?.description ?? "");
    setPendingMembers([]);
    setPendingRemovals([]);
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setPendingNavigation("close");
    else setSelected("");
  };
  const saveEdits = () =>
    void run(
      async (isCurrent) => {
        if (nameDirty || descriptionDirty) {
          await AccessGroupsApi.rename(selected, renameName.trim(), descriptionDirty ? editDescription.trim() : undefined);
          if (!isCurrent()) return;
          await mutate();
        }
        for (const [operation, ids, clearPending] of [
          ["remove", pendingRemovals, setPendingRemovals],
          ["add", pendingMembers, setPendingMembers],
        ] as const) {
          try {
            for (
              let offset = 0;
              offset < ids.length;
              offset += MEMBER_BATCH_LIMIT
            ) {
              if (!isCurrent()) return;
              const batch = ids.slice(offset, offset + MEMBER_BATCH_LIMIT);
              await AccessGroupsApi.changeMembers(selected, operation, batch);
              if (!isCurrent()) return;
              const saved = new Set(batch);
              clearPending((previous) =>
                previous.filter((id) => !saved.has(id)),
              );
            }
          } finally {
            if (ids.length && isCurrent()) await refreshMembers();
          }
        }
      },
      async () => {
        setEditing(false);
      },
    );
  if (!isAdmin)
    return (
      <Box p="5">
        <Text>{t("accessGroups.adminOnly")}</Text>
      </Box>
    );
  const shown = (groups ?? []).filter((group) =>
    group.name.toLowerCase().includes(groupSearch.toLowerCase().trim()),
  );
  const creatorCell = (group?: AccessGroup) => group?.createdByUser ? (
    <AvatarCell name={group.createdByUser.name || group.createdByUser.email || group.createdByUser.userId}
      email={group.createdByUser.email}
      isSelf={!!profile?.userId && profile.userId === group.createdByUser.userId} />
  ) : <Text size="2" color="gray">—</Text>;
  return (
    <Flex
      direction="column"
      style={{
        height: "100%",
        width: "100%",
        paddingInline: pagePaddingX(40),
        paddingBottom: PAGE_PADDING_TOP,
        boxSizing: "border-box",
      }}
    >
      <EntityPageHeader
        title={t("accessGroups.title")}
        subtitle={t("workspace.groups.subtitle")}
        titleAccessory={
          <HelpTooltip
            content={t("accessGroups.help")}
            open={helpOpen}
            onOpenChange={setHelpOpen}
          >
            <IconButton
              variant="ghost"
              color="gray"
              className="touch-hit"
              aria-label={t("accessGroups.helpTitle")}
              onClick={() => setHelpOpen((open) => !open)}
            >
              <MaterialIcon name="help_outline" size={18} />
            </IconButton>
          </HelpTooltip>
        }
        searchPlaceholder={t("workspace.groups.searchPlaceholder")}
        searchValue={groupSearch}
        onSearchChange={setGroupSearch}
        ctaLabel={t("accessGroups.create")}
        ctaIcon="shield"
        onCtaClick={() => {
          setName("");
          setDescription("");
          setCreating(true);
        }}
      />
      {(error || (failed && !selected && !creating)) && (
        <Callout.Root color="red">
          <Callout.Text>{t("accessGroups.error")}</Callout.Text>
        </Callout.Root>
      )}
      <Flex
        direction="column"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          border: "1px solid var(--olive-3)",
          borderRadius: "var(--radius-1)",
          backgroundColor: "var(--olive-1)",
        }}
      >
        <EntityDataTable<AccessGroup>
          columns={[
            {
              key: "name",
              label: t("accessGroups.name"),
              width: "20%",
              minWidth: "160px",
              render: (group) => <AvatarCell name={group.name} />,
            },
            {
              key: "description", label: t("workspace.groups.columns.description"), minWidth: "180px",
              render: (group) => <Text size="2" style={{ color: "var(--slate-11)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={group.description}>{group.description || "—"}</Text>,
            },
            {
              key: "createdBy", label: t("workspace.groups.columns.createdBy"), hideOnMobile: true, width: "20%", minWidth: "180px",
              render: creatorCell,
            },
            {
              key: "createdOn", label: t("workspace.groups.columns.createdOn"), hideOnMobile: true, width: "140px",
              render: (group) => <Text size="2" color="gray">{group.createdAtTimestamp ? formatDate(group.createdAtTimestamp) : "—"}</Text>,
            },
          ]}
          data={shown}
          getItemId={(group) => group._key}
          selectedIds={selectedRows}
          onSelectionChange={setSelectedRows}
          isLoading={groupsLoading}
          onRowClick={(group) => openGroup(group)}
          renderRowActions={(group) => (
            <EntityRowActionMenu
              actions={[
                {
                  icon: "person",
                  label: t("accessGroups.members"),
                  onClick: () => openGroup(group),
                },
                {
                  icon: "shield",
                  label: t("workspace.groups.actions.managePermissions"),
                  onClick: () => openGroup(group, "access"),
                },
              ]}
            />
          )}
        />
        <EntityPagination
          page={Math.floor(skip / limit) + 1}
          limit={limit}
          itemCount={shown.length}
          hasNextPage={!error && (groupPage?.hasMore ?? false)}
          disabled={groupsLoading}
          onPageChange={(page) => {
            setSkip((page - 1) * limit);
            setSelectedRows(new Set());
          }}
          onLimitChange={(value) => {
            setLimit(value);
            setSkip(0);
            setSelectedRows(new Set());
          }}
        />
      </Flex>
      <WorkspaceRightPanel
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
        title={t("accessGroups.create")}
        icon="shield"
        primaryLabel={t("accessGroups.create")}
        primaryDisabled={!name.trim()}
        primaryLoading={busy}
        onPrimaryClick={() =>
          void run(
            () => AccessGroupsApi.create(name.trim(), description.trim() || undefined),
            async () => {
              setName("");
              setDescription("");
              setCreating(false);
              await mutate();
            },
          )
        }
      >
        <Flex
          direction="column"
          gap="4"
          p="4"
          style={{
            backgroundColor: "var(--olive-2)",
            border: "1px solid var(--olive-3)",
            borderRadius: "var(--radius-2)",
          }}
        >
          {failed && (
            <Callout.Root color="red">
              <Callout.Text>{t("accessGroups.error")}</Callout.Text>
            </Callout.Root>
          )}
          <FormField
            label={t("accessGroups.name")}
            required
          >
            <GroupNameInput
              value={name}
              canEditName={!busy}
              ariaLabel={t("accessGroups.name")}
              onChange={setName}
            />
          </FormField>
          <FormField label={t("workspace.groups.create.descriptionLabel")} optional>
            <EntityDescriptionInput value={description} onChange={setDescription} canEdit={!busy}
              maxLength={2000} placeholder={t("workspace.groups.create.descriptionPlaceholder")} />
          </FormField>
        </Flex>
      </WorkspaceRightPanel>
      <WorkspaceRightPanel
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        title={selectedGroup?.name ?? ""}
        icon="shield"
        hideFooter={tab === "access"}
        primaryLabel={t(
          editing ? "workspace.groups.edit.save" : "workspace.groups.edit.edit",
        )}
        primaryLoading={busy}
        primaryDisabled={
          !!memberError || !members || (editing && !renameName.trim())
        }
        onPrimaryClick={() => {
          if (editing) saveEdits();
          else setEditing(true);
        }}
        secondaryLabel={t(editing ? "common.cancel" : "common.close")}
        onSecondaryClick={() => {
          if (!busy) {
            if (editing) resetEdits();
            else requestClose();
          }
        }}
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (busy) return;
            if (dirty) setPendingNavigation(value);
            else setTab(value);
          }}
          key={selected}
        >
          <Tabs.List>
            <Tabs.Trigger value="members">
              {t("accessGroups.members")}
            </Tabs.Trigger>
            <Tabs.Trigger value="access">
              {t("workspace.groups.detail.accessPermissions")}
            </Tabs.Trigger>
          </Tabs.List>
          <Box pt="4">
            <Tabs.Content value="members">
              <Flex
                direction="column"
                gap="4"
                p="4"
                style={{
                  backgroundColor: "var(--olive-2)",
                  border: "1px solid var(--olive-3)",
                  borderRadius: "var(--radius-2)",
                }}
              >
                {(failed || memberError) && (
                  <Callout.Root color="red">
                    <Callout.Text>{t("accessGroups.error")}</Callout.Text>
                  </Callout.Root>
                )}
                <FormField label={t("accessGroups.name")}>
                  <GroupNameInput
                    value={renameName}
                    canEditName={editing && !busy}
                    ariaLabel={t("accessGroups.name")}
                    onChange={setRenameName}
                  />
                </FormField>
                <FormField label={t("workspace.groups.detail.descriptionLabel")}>
                  <EntityDescriptionInput value={editDescription} onChange={setEditDescription}
                    canEdit={editing && !busy} maxLength={2000} placeholder={t("workspace.groups.detail.descriptionPlaceholder")} />
                </FormField>
                <Flex direction="column" gap="4" p="4" style={{ backgroundColor: "var(--olive-2)", border: "1px solid var(--olive-3)", borderRadius: "var(--radius-2)" }}>
                  <Text size="2" weight="medium">{t("workspace.groups.detail.createdBy")}</Text>
                  {creatorCell(selectedGroup)}
                  <Text size="2" weight="medium">{t("workspace.groups.columns.createdOn")}</Text>
                  <Text size="2" color="gray">{selectedGroup?.createdAtTimestamp ? formatDate(selectedGroup.createdAtTimestamp) : "—"}</Text>
                </Flex>
                <Box
                  p="4"
                  style={{
                    border: "1px solid var(--olive-3)",
                    borderRadius: "var(--radius-2)",
                  }}
                >
                  <Flex direction="column" gap="3">
                    <Flex align="center" justify="between">
                      <Text size="2" weight="medium">{t("accessGroups.members")}</Text>
                      <Badge variant="soft" color="gray">
                        {members?.length ?? "—"}
                      </Badge>
                    </Flex>
                    {members && (
                      <PaginatedMembersList
                        key={`${selected}:${members.map((member) => member.userId).join(",")}`}
                        fetcher={async (search, page, pageSize) => {
                          const query = search?.toLowerCase() ?? "";
                          const filtered = members.filter((member) =>
                            `${member.userName ?? ""} ${member.userEmail ?? ""}`
                              .toLowerCase()
                              .includes(query),
                          );
                          return {
                            items: filtered.slice(
                              (page - 1) * pageSize,
                              page * pageSize,
                            ),
                            totalCount: filtered.length,
                          };
                        }}
                        keyExtractor={(member) => member.userId}
                        searchPlaceholder={t(
                          "workspace.groups.detail.searchUsers",
                        )}
                        emptyText={t("workspace.groups.detail.noUsers")}
                        maxHeight={320}
                        listClassName="team-member-scroll-area"
                        renderItem={(member) => (
                          <EntityMemberRow
                            pendingRemoval={pendingRemovals.includes(member.userId)}
                            name={member.userName || member.userEmail || member.userId}
                            email={member.userEmail} profilePicture={member.profilePicture}
                            isSelf={!!profile?.userId && profile.userId === member.userId}
                          >
                            {editing && (
                              <Button
                                variant="ghost"
                                color="gray"
                                style={{ color: pendingRemovals.includes(member.userId) ? "var(--accent-11)" : "var(--red-11)" }}
                                className="touch-hit"
                                disabled={busy}
                                onClick={() =>
                                  setPendingRemovals((previous) =>
                                    previous.includes(member.userId)
                                      ? previous.filter(
                                          (id) => id !== member.userId,
                                        )
                                      : [...previous, member.userId],
                                  )
                                }
                              >
                                {t(
                                  pendingRemovals.includes(member.userId)
                                    ? "workspace.groups.edit.undo"
                                    : "accessGroups.remove",
                                )}
                              </Button>
                            )}
                          </EntityMemberRow>
                        )}
                      />
                    )}
                    {!members && !memberError && (
                      <Text size="2" color="gray">
                        {t("common.loading")}
                      </Text>
                    )}

                  </Flex>
                </Box>
                    {editing && (
                      <Box p="4" style={{ backgroundColor: "var(--olive-2)", border: "1px solid var(--olive-3)", borderRadius: "var(--radius-2)" }}>
                        <Flex align="center" justify="between" mb="2">
                          <Text size="2" weight="medium">{t("workspace.groups.edit.addUsersLabel")}</Text>
                          <Badge variant="soft" color="gray" size="1">{t("workspace.common.selected", { count: pendingMembers.length })}</Badge>
                        </Flex>
                        <SearchableCheckboxDropdown
                          options={people.options.filter(
                            (person) =>
                              !members?.some(
                                (member) => member.userId === person.id,
                              ),
                          )}
                          selectedIds={pendingMembers}
                          onSelectionChange={setPendingMembers}
                          placeholder={t(
                            "workspace.groups.edit.addUsersPlaceholder",
                          )}
                          showAvatar
                          disabled={busy || !members || !!memberError}
                          onSearch={people.onSearch}
                          onLoadMore={people.onLoadMore}
                          isLoadingMore={people.isLoading}
                          hasMore={people.hasMore}
                        />
                      </Box>
                    )}
              </Flex>
              {editing && (
                <Flex
                  direction="column"
                  gap="3"
                  mt="4"
                  p="4"
                  style={{
                    backgroundColor: "var(--olive-2)",
                    border: "1px solid var(--olive-3)",
                    borderRadius: "var(--radius-2)",
                  }}
                >
                  <Text size="3" weight="medium">
                    {t("workspace.groups.edit.deleteTitle", {
                      name: selectedGroup?.name,
                    })}
                  </Text>
                  <Text size="2" color="gray">
                    {t("accessGroups.confirmDelete")}
                  </Text>
                  <Button
                    color="red"
                    variant="outline"
                    disabled={busy}
                    style={{ alignSelf: "start" }}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("accessGroups.delete")}
                  </Button>
                </Flex>
              )}
            </Tabs.Content>
            <Tabs.Content value="access">
              {selected && (
                <GroupAccessPanel
                  key={selected}
                  groupId={selected}
                  onDirtyChange={setAccessDirty}
                />
              )}
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </WorkspaceRightPanel>
      <ConfirmationDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        container={deleteDialogHost}
        title={t("accessGroups.delete")}
        message={t("accessGroups.confirmDelete")}
        confirmLabel={t("accessGroups.delete")}
        isLoading={busy}
        onConfirm={() =>
          void run(
            () => AccessGroupsApi.delete(selected),
            async () => {
              setConfirmDelete(false);
              setSelected("");
              await mutate();
            },
          )
        }
      />
      <ConfirmationDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
        container={deleteDialogHost}
        title={t("workspace.profile.discardTitle")}
        message={t("workspace.profile.discardMessage")}
        confirmLabel={t("workspace.profile.discardConfirm")}
        cancelLabel={t("workspace.profile.discardCancel")}
        onConfirm={() => {
          if (pendingNavigation === "close") setSelected("");
          else setTab(pendingNavigation!);
          setAccessDirty(false);
          resetEdits();
          setPendingNavigation(null);
        }}
      />
    </Flex>
  );
}
