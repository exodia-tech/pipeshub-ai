"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Text,
  TextField,
  Tabs,
} from "@radix-ui/themes";
import { pagePaddingX } from "@/app/components/ui/responsive";
import { captureSession, onSessionEnd } from "@/lib/api/session-cache";
import { selectIsAdmin, useUserStore } from "@/lib/store/user-store";
import {
  AvatarCell,
  EntityDataTable,
  EntityPageHeader,
  WorkspaceRightPanel,
  SearchableCheckboxDropdown,
} from "../components";
import { PAGE_PADDING_TOP } from "../components/settings-page-container";
import { usePaginatedUserOptions } from "../hooks/use-paginated-user-options";
import { GroupAccessPanel } from "./group-access-panel";
import { AccessGroupsApi, type AccessGroup } from "./access-api";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { useWorkspaceDrawerNestedModalHost } from "../components/workspace-right-panel";

export default function AccessGroupsPage() {
  const { t } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const [skip, setSkip] = useState(0);
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renameName, setRenameName] = useState("");
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
    data: groups,
    error,
    mutate,
  } = useSWR(isAdmin ? ["access-groups", skip] : null, () =>
    AccessGroupsApi.list(skip),
  );
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
        setSelected("");
        setCreating(false);
        setName("");
        setRenameName("");
        setPendingMembers([]);
        setGroupSearch("");
        setSelectedRows(new Set());
        setBusy(false);
        setFailed(false);
      }),
    [],
  );
  const run = async (
    work: () => Promise<unknown>,
    after: () => Promise<unknown>,
  ) => {
    if (busy) return;
    const current = captureSession();
    setBusy(true);
    setFailed(false);
    try {
      await work();
      if (current()) await after();
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const openGroup = (group: AccessGroup) => {
    setSelected(group._key);
    setRenameName(group.name);
    setPendingMembers([]);
    setFailed(false);
    setTab("members");
    setAccessDirty(false);
  };
  if (!isAdmin)
    return (
      <Box p="5">
        <Text>{t("accessGroups.adminOnly")}</Text>
      </Box>
    );
  const shown = (groups ?? []).filter((group) =>
    group.name.toLowerCase().includes(groupSearch.toLowerCase().trim()),
  );
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
        subtitle={t("accessGroups.help")}
        searchPlaceholder={t("workspace.teams.searchPlaceholder")}
        searchValue={groupSearch}
        onSearchChange={setGroupSearch}
        ctaLabel={t("accessGroups.create")}
        ctaIcon="groups"
        onCtaClick={() => {
          setName("");
          setCreating(true);
        }}
      />
      {(failed || error || memberError) && (
        <Callout.Root color="red">
          <Callout.Text>{t("accessGroups.error")}</Callout.Text>
        </Callout.Root>
      )}
      <Flex
        direction="column"
        style={{
          flex: 1,
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
              render: (group) => <AvatarCell name={group.name} />,
            },
          ]}
          data={shown}
          getItemId={(group) => group._key}
          selectedIds={selectedRows}
          onSelectionChange={setSelectedRows}
          isLoading={!groups && !error}
          onRowClick={openGroup}
        />
        <Flex gap="2" p="3" justify="end">
          <Button
            variant="soft"
            disabled={skip === 0}
            onClick={() => setSkip(Math.max(0, skip - 100))}
          >
            {t("accessGroups.previous")}
          </Button>
          <Button
            variant="soft"
            disabled={!groups || groups.length < 100}
            onClick={() => setSkip(skip + 100)}
          >
            {t("accessGroups.next")}
          </Button>
        </Flex>
      </Flex>
      <WorkspaceRightPanel
        open={creating}
        onOpenChange={setCreating}
        title={t("accessGroups.create")}
        icon="groups"
        primaryLabel={t("accessGroups.create")}
        primaryDisabled={!name.trim()}
        primaryLoading={busy}
        onPrimaryClick={() =>
          void run(
            () => AccessGroupsApi.create(name.trim()),
            async () => {
              setName("");
              setCreating(false);
              await mutate();
            },
          )
        }
      >
        <label>
          {t("accessGroups.name")}
          <TextField.Root
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </WorkspaceRightPanel>
      <WorkspaceRightPanel
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            if (accessDirty) setPendingNavigation("close");
            else setSelected("");
          }
        }}
        title={groups?.find((group) => group._key === selected)?.name ?? ""}
        icon="groups"
        hideFooter
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (accessDirty) setPendingNavigation(value);
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
                  background: "var(--olive-2)",
                  border: "1px solid var(--olive-3)",
                  borderRadius: "var(--radius-2)",
                }}
              >
                <Flex gap="2" align="end" wrap="wrap">
                  <label style={{ flex: 1, minWidth: 200 }}>
                    <Text as="span" size="2" weight="medium">
                      {t("accessGroups.name")}
                    </Text>
                    <TextField.Root
                      size="3"
                      value={renameName}
                      onChange={(event) => setRenameName(event.target.value)}
                    />
                  </label>
                  <Button
                    variant="soft"
                    disabled={busy || !renameName.trim()}
                    onClick={() =>
                      void run(
                        () =>
                          AccessGroupsApi.rename(selected, renameName.trim()),
                        async () => {
                          await mutate();
                        },
                      )
                    }
                  >
                    {t("accessGroups.rename")}
                  </Button>
                  <Button
                    color="red"
                    variant="soft"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("accessGroups.delete")}
                  </Button>
                </Flex>
                <Box
                  p="4"
                  style={{
                    border: "1px solid var(--olive-3)",
                    borderRadius: "var(--radius-2)",
                  }}
                >
                  <Flex direction="column" gap="4">
                    <Flex align="center" justify="between">
                      <Heading size="3">{t("accessGroups.members")}</Heading>
                      <Text size="2" color="gray">
                        {members?.length ?? "—"}
                      </Text>
                    </Flex>
                    {(members ?? []).map((member) => (
                      <Flex
                        key={member.userId}
                        align="center"
                        justify="between"
                        gap="3"
                      >
                        <AvatarCell
                          name={
                            member.userName || member.userEmail || member.userId
                          }
                          email={member.userEmail}
                        />
                        <Button
                          variant="soft"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                AccessGroupsApi.changeMembers(
                                  selected,
                                  "remove",
                                  [member.userId],
                                ),
                              refreshMembers,
                            )
                          }
                        >
                          {t("accessGroups.remove")}
                        </Button>
                      </Flex>
                    ))}
                    <SearchableCheckboxDropdown
                      options={people.options.filter(
                        (person) =>
                          !members?.some(
                            (member) => member.userId === person.id,
                          ),
                      )}
                      selectedIds={pendingMembers}
                      onSelectionChange={setPendingMembers}
                      placeholder={t("workspace.teams.edit.addUsersLabel")}
                      showAvatar
                      disabled={busy || !members}
                      onSearch={people.onSearch}
                      onLoadMore={people.onLoadMore}
                      isLoadingMore={people.isLoading}
                      hasMore={people.hasMore}
                    />
                    <Button
                      disabled={busy || !pendingMembers.length}
                      onClick={() =>
                        void run(
                          () =>
                            AccessGroupsApi.changeMembers(
                              selected,
                              "add",
                              pendingMembers,
                            ),
                          async () => {
                            setPendingMembers([]);
                            await refreshMembers();
                          },
                        )
                      }
                    >
                      {t("accessGroups.add")}
                    </Button>
                  </Flex>
                </Box>
                <Text size="2" color="gray">
                  {t("accessGroups.help")}
                </Text>
              </Flex>
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
          setPendingNavigation(null);
        }}
      />
    </Flex>
  );
}
