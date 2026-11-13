"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import {
  Box,
  Callout,
  Flex,
  Heading,
  IconButton,
  Badge,
  Text,
} from "@radix-ui/themes";
import { captureSession, onSessionEnd } from "@/lib/api/session-cache";
import { selectIsAdmin, useUserStore } from "@/lib/store/user-store";
import { auditApi, type AuditEvent } from "./api";
import {
  EntityPageHeader,
  EntityDataTable,
  EntityFilterBar,
  EntityPagination,
  AvatarCell,
  WorkspaceRightPanel,
} from "../components";
import { DateRangePicker, FilterDropdown } from "@/app/components/ui";
import { HelpTooltip } from "@/app/components/ui/help-tooltip";
import { MaterialIcon } from "@/app/components/ui/MaterialIcon";
import { pagePaddingX } from "@/app/components/ui/responsive";
import { PAGE_PADDING_TOP } from "../components/settings-page-container";
import { UsersApi } from "../users/api";
import { AccessGroupsApi } from "../groups/access-api";
import { usePaginatedUserOptions } from "../hooks/use-paginated-user-options";

const actions = [
  "group.create",
  "group.rename",
  "group.delete",
  "group.access.change",
  "group.members.add",
  "group.members.remove",
  "audit.read",
  "audit.export",
  "collection.permission.grant",
  "collection.permission.change",
  "collection.permission.revoke",
  "record.download.start",
  "auth.login",
  "chat.context.read",
  "agent.run",
  "agent.tool",
];

export default function AuditPage() {
  const { t, i18n } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const people = usePaginatedUserOptions({
    enabled: isAdmin,
    idField: "userId",
  });
  const { data: groups } = useSWR(isAdmin ? "audit-groups" : null, () =>
    AccessGroupsApi.list(),
  );
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState("");
  const [limit, setLimit] = useState(50);
  const [history, setHistory] = useState<string[]>([]);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  useEffect(
    () =>
      onSessionEnd(() => {
        setDetail(null);
        setSelectedRows(new Set());
        setFilters({});
        setCursor("");
        setLimit(50);
        setHistory([]);
        setFromDay("");
        setToDay("");
        setExporting(false);
        setExportError(false);
        setCoverageOpen(false);
      }),
    [],
  );
  const validDay = (value: string) =>
    !value ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)));
  const validFilters =
    (!filters.actor_id || /^[a-fA-F0-9]{24}$/.test(filters.actor_id)) &&
    (!filters.group_id ||
      /^(?:[a-fA-F0-9]{24}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12})$/.test(
        filters.group_id,
      )) &&
    (!filters.resource_id ||
      /^[a-zA-Z0-9_-]{1,256}$/.test(filters.resource_id)) &&
    validDay(fromDay) &&
    validDay(toDay) &&
    (!fromDay || !toDay || fromDay <= toDay);
  const params = {
    ...filters,
    ...(fromDay && validDay(fromDay)
      ? { from: new Date(`${fromDay}T00:00:00Z`).toISOString() }
      : {}),
    ...(toDay && validDay(toDay)
      ? {
          to: new Date(
            Date.parse(`${toDay}T00:00:00Z`) + 86400000,
          ).toISOString(),
        }
      : {}),
    ...(cursor ? { cursor } : {}),
    limit: String(limit),
  };
  const { data, error, isLoading } = useSWR(
    isAdmin && validFilters ? ["audit-history", params] : null,
    () => auditApi.list(params),
    { keepPreviousData: false },
  );
  const malformed = !!data && !Array.isArray(data.events);
  const actorIds =
    data && !malformed
      ? Array.from(new Set(data.events.map((event) => event.actor_id)))
      : [];
  const { data: actors } = useSWR(
    isAdmin && actorIds.length ? ["audit-actors", actorIds] : null,
    () => UsersApi.getUsersByIds(actorIds, { suppressErrorToast: true }),
  );
  const actorName = (id: string) =>
    actors?.find((person) => person.userId === id)?.name || id;
  const resetPagination = () => {
    setCursor("");
    setHistory([]);
    setSelectedRows(new Set());
    setDetail(null);
  };
  const setFilter = (key: string, value: string) => {
    setFilters((previous) => {
      const next = { ...previous };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    resetPagination();
  };
  const exportPage = async () => {
    if (!data || exporting) return;
    const sessionIsCurrent = captureSession();
    setExporting(true);
    setExportError(false);
    try {
      const exported = await auditApi.list({ ...params, export: "true" });
      if (!Array.isArray(exported.events))
        throw new Error("Invalid audit export");
      if (!sessionIsCurrent()) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported.events, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit-current-page.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      if (sessionIsCurrent()) setExportError(true);
    } finally {
      if (sessionIsCurrent()) setExporting(false);
    }
  };
  if (!isAdmin)
    return (
      <Box p="5">
        <Text>{t("audit.adminOnly")}</Text>
      </Box>
    );
  const eventLabel = (value: string) =>
    value.replaceAll(".", " · ").replaceAll("_", " ");
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
        title={t("audit.title")}
        subtitle={t("audit.subtitle")}
        searchPlaceholder={t("audit.resource")}
        searchValue={filters.resource_id ?? ""}
        onSearchChange={(value) => setFilter("resource_id", value)}
        ctaLabel={t("audit.exportPage")}
        ctaIcon="download"
        titleAccessory={
          <HelpTooltip
            content={`${t("audit.coverage")}\n\n${t("audit.agentCoverage")}\n\n${t("audit.loginWarning")}`}
            maxWidth="360px"
            open={coverageOpen}
            onOpenChange={setCoverageOpen}
          >
            <IconButton
              variant="ghost"
              color="gray"
              className="touch-hit"
              aria-label={t("audit.coverageTitle")}
              onClick={() => setCoverageOpen((open) => !open)}
            >
              <MaterialIcon name="help_outline" size={18} />
            </IconButton>
          </HelpTooltip>
        }
        onCtaClick={() => void exportPage()}
        ctaDisabled={
          !data?.events?.length ||
          exporting ||
          !!error ||
          malformed ||
          !validFilters
        }
      />
      <Flex direction="column" gap="3" style={{ flex: 1, minHeight: 0 }}>
        {(!validFilters || error || malformed || exportError) && (
          <Callout.Root color="red">
            <Callout.Text>
              {t(!validFilters ? "audit.invalidFilters" : "audit.error")}
            </Callout.Text>
          </Callout.Root>
        )}
        <Flex
          direction="column"
          style={{
            flex: 1,
            minHeight: 0,
            border: "1px solid var(--olive-3)",
            borderRadius: "var(--radius-1)",
            background: "var(--olive-1)",
            overflow: "hidden",
          }}
        >
          <EntityFilterBar
            filters={[
              { key: "action", label: t("audit.action"), icon: "bolt" },
              {
                key: "outcome",
                label: t("audit.outcome"),
                icon: "check_circle",
              },
              {
                key: "actor_id",
                label: t("accessGroups.members"),
                icon: "person",
              },
              {
                key: "group_id",
                label: t("accessGroups.title"),
                icon: "groups",
              },
              {
                key: "from_day",
                label: t("audit.from"),
                icon: "calendar_today",
              },
              { key: "to_day", label: t("audit.to"), icon: "calendar_today" },
            ]}
            renderFilter={(filter) => {
              if (filter.key === "from_day" || filter.key === "to_day")
                return (
                  <DateRangePicker
                    label={filter.label}
                    icon={filter.icon}
                    fixedDateType="on"
                    dateType="on"
                    startDate={filter.key === "from_day" ? fromDay : toDay}
                    onApply={(day) => {
                      if (filter.key === "from_day") setFromDay(day);
                      else setToDay(day);
                      resetPagination();
                    }}
                    onClear={() => {
                      if (filter.key === "from_day") setFromDay("");
                      else setToDay("");
                      resetPagination();
                    }}
                  />
                );
              const isMember = filter.key === "actor_id";
              return (
                <FilterDropdown
                  label={filter.label}
                  icon={filter.icon}
                  selectionMode="single"
                  searchable={isMember || filter.key === "group_id"}
                  options={
                    isMember
                      ? people.options.map((person) => ({
                          value: person.id,
                          label: person.label,
                        }))
                      : filter.key === "group_id"
                        ? (groups ?? []).map((group) => ({
                            value: group._key,
                            label: group.name,
                          }))
                        : (filter.key === "action"
                            ? actions
                            : [
                                "intent",
                                "success",
                                "denied",
                                "failed",
                                "cancelled",
                                "pending",
                              ]
                          ).map((value) => ({
                            value,
                            label: eventLabel(value),
                          }))
                  }
                  selectedValues={
                    filters[filter.key] ? [filters[filter.key]] : []
                  }
                  onSelectionChange={(values) =>
                    setFilter(filter.key, values[0] ?? "")
                  }
                  onSearch={isMember ? people.onSearch : undefined}
                  onLoadMore={isMember ? people.onLoadMore : undefined}
                  isLoadingMore={isMember && people.isLoading}
                  hasMore={isMember && people.hasMore}
                />
              );
            }}
          />
          <EntityDataTable<AuditEvent>
            columns={[
              {
                key: "time",
                label: t("audit.time"),
                width: "180px",
                render: (event) => (
                  <Text size="2" color="gray">
                    {new Date(event.recorded_at).toLocaleString(i18n.language)}
                  </Text>
                ),
              },
              {
                key: "actor",
                label: t("accessGroups.members"),
                render: (event) => (
                  <AvatarCell name={actorName(event.actor_id)} />
                ),
              },
              {
                key: "action",
                label: t("audit.action"),
                render: (event) => (
                  <Text size="2">{eventLabel(event.action)}</Text>
                ),
              },
              {
                key: "outcome",
                label: t("audit.outcome"),
                width: "100px",
                render: (event) => (
                  <Badge
                    color={
                      event.outcome === "denied" || event.outcome === "failed"
                        ? "red"
                        : event.outcome === "success"
                          ? "blue"
                          : "gray"
                    }
                    variant="soft"
                  >
                    {event.outcome}
                  </Badge>
                ),
              },
            ]}
            data={data && !malformed && validFilters ? data.events : []}
            getItemId={(event) => event.id}
            selectedIds={selectedRows}
            onSelectionChange={setSelectedRows}
            onRowClick={setDetail}
            isLoading={isLoading}
          />
          {data && !malformed && !data.events.length && (
            <Text size="2" color="gray" align="center" style={{ padding: 16 }}>
              {t("audit.empty")}
            </Text>
          )}
          <EntityPagination
            page={history.length + 1}
            limit={limit}
            itemCount={
              data && !malformed && validFilters ? data.events.length : 0
            }
            hasNextPage={
              !error && !malformed && validFilters && !!data?.next_cursor
            }
            disabled={isLoading}
            onPageChange={(page) => {
              setSelectedRows(new Set());
              setDetail(null);
              if (page < history.length + 1) {
                setCursor(history[history.length - 1]);
                setHistory(history.slice(0, -1));
              } else if (data?.next_cursor) {
                setHistory([...history, cursor]);
                setCursor(data.next_cursor);
              }
            }}
            onLimitChange={(value) => {
              setLimit(value);
              resetPagination();
            }}
          />
        </Flex>
      </Flex>
      <WorkspaceRightPanel
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        title={t("audit.title")}
        icon="history"
        hideFooter
      >
        {detail && (
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
            {[
              [
                "time",
                new Date(detail.recorded_at).toLocaleString(i18n.language),
              ],
              ["action", eventLabel(detail.action)],
              ["outcome", detail.outcome],
              ["actorId", detail.actor_id],
              ["groupId", detail.group_ids.join(", ")],
              ["members", detail.member_ids.join(", ")],
              ["operation", detail.operation_id],
              ["resource", detail.resource_id],
              ["role", detail.permission_role],
              ...(detail.agent_event
                ? [
                    ["agentId", detail.agent_event.agent_id],
                    ["runId", detail.agent_event.run_id],
                    ["traceId", detail.agent_event.trace_id],
                    ["parentRunId", detail.agent_event.parent_run_id],
                    ["tool", detail.agent_event.tool_name],
                    ["toolCallId", detail.agent_event.tool_call_id],
                    ["model", detail.agent_event.model],
                  ]
                : []),
            ]
              .filter(([, value]) => value)
              .map(([key, value]) => (
                <Flex direction="column" gap="1" key={key}>
                  <Text size="1" color="gray">
                    {t(`audit.${key}`)}
                  </Text>
                  <Text size="2" style={{ overflowWrap: "anywhere" }}>
                    {value || "—"}
                  </Text>
                </Flex>
              ))}
            {detail.resource_policy && (
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium">
                  {t("workspace.groups.detail.accessPermissions")}
                </Text>
                <Badge>
                  {t(
                    detail.resource_policy.default_allow
                      ? "groupAccess.all"
                      : "groupAccess.selected",
                  )}
                </Badge>
                {detail.resource_policy.rules.map((rule) => (
                  <Flex gap="2" key={rule.resource_ref} justify="between">
                    <Text size="1" style={{ overflowWrap: "anywhere" }}>
                      {rule.resource_ref}
                    </Text>
                    <Badge color={rule.allow ? "blue" : "gray"}>
                      {t(
                        rule.allow
                          ? "groupAccess.allowed"
                          : "groupAccess.blocked",
                      )}
                    </Badge>
                  </Flex>
                ))}
                {detail.resource_policy.feature_scopes !== undefined && (
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="medium">{t("groupScopes.title")}</Text>
                    <Text size="2" style={{ overflowWrap: "anywhere" }}>
                      {detail.resource_policy.feature_scopes === null ? t("groupScopes.unrestricted") :
                        detail.resource_policy.feature_scopes.length ? detail.resource_policy.feature_scopes.join(", ") : t("groupScopes.selected", { count: 0 })}
                    </Text>
                  </Flex>
                )}
              </Flex>
            )}
          </Flex>
        )}
      </WorkspaceRightPanel>
    </Flex>
  );
}
