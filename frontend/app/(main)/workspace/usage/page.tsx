"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import {
  Box,
  Flex,
  Grid,
  Text,
  Heading,
  Button,
  IconButton,
  Tooltip,
  Select,
  Tabs,
  TextField,
  Callout,
  VisuallyHidden,
} from "@radix-ui/themes";
import { DateRangePicker } from "@/app/components/ui/date-range-picker";
import { FilterDropdown } from "@/app/components/ui/filter-dropdown";
import { HelpTooltip } from "@/app/components/ui/help-tooltip";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { MaterialIcon } from "@/app/components/ui/MaterialIcon";
import { useUserStore, selectIsAdmin } from "@/lib/store/user-store";
import { onSessionEnd } from "@/lib/api/session-cache";
import { ConnectorsApi } from "../connectors/api";
import {
  SettingsPageContainer,
  SettingsSection,
  EntityDataTable,
  EntityPagination,
  EntityRowActionMenu,
} from "../components";
import { usageApi, type Breakdown, type Rate, type UsageEvent } from "./api";
import {
  exclusiveEnd,
  chartMaximum,
  metricValue,
  money,
  seriesSegments,
  timelineTicks,
  type UsageMetric,
} from "./format";

const FIELDS = [
  "provider",
  "model",
  "user_id",
  "connector_id",
  "workload",
  "kind",
  "status",
] as const;
const RATE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;

export default function UsagePage() {
  const { t, i18n } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const profile = useUserStore((state) => state.profile);
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(() =>
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  );
  const [end, setEnd] = useState(today);
  const [view, setView] = useState("personal");
  const [audience, setAudience] = useState("all");
  const [tab, setTab] = useState("overview");
  const [interval, setInterval] = useState("day");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [helpOpen, setHelpOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [budgetScope, setBudgetScope] = useState("organization");
  const [budgetSubject, setBudgetSubject] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [warning, setWarning] = useState("80");
  const [rate, setRate] = useState<Rate>({
    provider: "",
    model: "",
    rates: { input: "", output: "", cache_read: "", cache_write: "" },
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState(false);
  useEffect(
    () =>
      onSessionEnd(() => {
        setView("personal");
        setAudience("all");
        setFilters({});
        setFiltersOpen(false);
        setOffset(0);
        setTab("overview");
        setBudgetSubject("");
        setBudgetAmount("");
        setSaving(false);
        setNotice("");
        setRate({
          provider: "",
          model: "",
          rates: { input: "", output: "", cache_read: "", cache_write: "" },
        });
      }),
    [],
  );
  const validDates = Boolean(
    start &&
    end &&
    start <= end &&
    Date.parse(end) - Date.parse(start) <
      (interval === "hour" ? 31 : 366) * 86_400_000,
  );
  const params = {
    view,
    interval,
    ...filters,
    audience: view === "organization" ? audience : "all",
    from: `${start}T00:00:00Z`,
    to: validDates ? exclusiveEnd(end) : "",
    offset,
    limit: pageSize,
  };
  const { data, error, isLoading, mutate } = useSWR(
    validDates ? ["usage-report", params] : null,
    () => usageApi.report(params),
    { refreshInterval: 30_000, keepPreviousData: false },
  );
  const {
    data: budgetData,
    error: budgetError,
    isLoading: budgetsLoading,
    mutate: refreshBudgets,
  } = useSWR(
    tab === "budgets" ? ["usage-budgets", view] : null,
    () => usageApi.budgets(view),
    { refreshInterval: 30_000 },
  );
  const {
    data: rateData,
    error: rateError,
    mutate: refreshRates,
  } = useSWR(
    isAdmin && tab === "pricing" ? "usage-rates" : null,
    usageApi.rates,
  );
  const { data: connectorNames } = useSWR(
    isAdmin && view === "organization" ? "usage-connector-names" : null,
    () =>
      ConnectorsApi.getActiveConnectors("team", 1, 100, {
        suppressErrorToast: true,
      }),
  );
  const { data: members } = useSWR(
    isAdmin && view === "organization" && validDates
      ? ["usage-members", start, end, interval]
      : null,
    () =>
      usageApi.report({
        view: "organization",
        interval,
        from: `${start}T00:00:00Z`,
        to: exclusiveEnd(end),
        limit: 1,
      }),
    { refreshInterval: 30_000, keepPreviousData: false },
  );
  const connectorLabel = (id: string) =>
    connectorNames?.connectors.find((connector) => connector._key === id)
      ?.name ?? id;
  const number = (v: number | null) =>
    v === null
      ? "—"
      : new Intl.NumberFormat(i18n.language, {
          maximumFractionDigits: 1,
        }).format(v);
  const display = (v: number | null) =>
    metric === "cost" ? money(v, i18n.language) : number(v);
  const updateFilter = (field: string, value: string) => {
    setFilters((previous) => ({
      ...previous,
      [field]: value === "__all__" ? "" : value,
    }));
    setOffset(0);
  };
  const label = (value: string) => t(`usage.${value}`);
  const rows = (field: string): Breakdown[] =>
    (field === "user_id"
      ? (members?.user_id ?? data?.user_id ?? [])
      : (data?.[field as (typeof FIELDS)[number]] ?? [])
    ).map((row) =>
      field === "connector_id" && row.id
        ? { ...row, label: connectorLabel(row.id) }
        : field === "kind" && row.id
          ? { ...row, label: t(`usage.${row.id}`, { defaultValue: row.label }) }
          : row,
    );
  const filterControl = (field: (typeof FIELDS)[number]) => (
    <FilterDropdown
      label={label(field)}
      selectionMode="single"
      searchable
      selectedValues={filters[field] ? [filters[field]] : []}
      onSelectionChange={(values) =>
        updateFilter(field, values[0] || "__all__")
      }
      options={[
        ...((field === "connector_id" ||
          (field === "user_id" && audience === "all")) &&
        rows(field).some((r) => r.id === null)
          ? [
              {
                value: "__none__",
                label: label(
                  field === "user_id" ? "background" : "noConnector",
                ),
              },
            ]
          : []),
        ...rows(field)
          .filter((r) => r.id)
          .map((r) => ({
            value: r.id!,
            label:
              field === "kind"
                ? t(`usage.${r.id}`, { defaultValue: r.label })
                : r.label,
          })),
        ...(filters[field] &&
        filters[field] !== "__none__" &&
        !rows(field).some((r) => r.id === filters[field])
          ? [{ value: filters[field], label: filters[field] }]
          : []),
      ]}
    />
  );
  const targetLabel = (scope: string, subject: string) =>
    scope === "organization"
      ? label("organization")
      : (rows(scope).find((r) => r.id === subject)?.label ?? subject);
  const save = async (
    action: () => Promise<unknown>,
    refresh: () => Promise<unknown>,
  ) => {
    setSaving(true);
    setNotice("");
    setSaveError(false);
    try {
      await action();
      await refresh();
      setNotice(label("saved"));
    } catch {
      setNotice(label("saveFailed"));
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };
  const bars = (items: Breakdown[], title: string) => {
    const top = [...items]
      .sort(
        (a, b) =>
          (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1),
      )
      .slice(0, 8)
      .map((row) => ({
        ...row,
        label:
          row.id === null
            ? label(
                row.label === "Background services"
                  ? "background"
                  : "noConnector",
              )
            : row.label,
      }));
    const max = chartMaximum(top, metric) || 1;
    return (
      <SettingsSection>
        <Heading size="3" mb="4">
          {title}
        </Heading>
        <Flex direction="column" gap="3">
          {!top.length && <Text color="gray">{label("noData")}</Text>}
          {top.map((row) => (
            <Box key={row.id ?? "__background__"}>
              <Flex justify="between" gap="3">
                <Text size="2" style={{ overflowWrap: "anywhere" }}>
                  {row.label}
                </Text>
                <Text size="2">{display(metricValue(row, metric))}</Text>
              </Flex>
              <Box
                role="img"
                aria-label={`${row.label}: ${display(metricValue(row, metric))}`}
                style={{
                  height: 8,
                  marginTop: 6,
                  background: "var(--gray-4)",
                  borderRadius: "var(--radius-2)",
                }}
              >
                <Box
                  style={{
                    height: "100%",
                    width: `${(Math.max(0, metricValue(row, metric) ?? 0) / max) * 100}%`,
                    background: "var(--accent-9)",
                    borderRadius: "inherit",
                  }}
                />
              </Box>
            </Box>
          ))}
        </Flex>
      </SettingsSection>
    );
  };
  const timeline = data?.timeline ?? [];
  const maxTimeline = chartMaximum(timeline, metric);
  const chartScale = maxTimeline || 1;
  const hasKnownActivity = timeline.some(
    (row) => row.requests > 0 && metricValue(row, metric) !== null,
  );
  const segments = seriesSegments(timeline, metric);
  const point = (index: number, value: number) =>
    `${(index / Math.max(1, timeline.length - 1)) * 700},${140 - (value / chartScale) * 125}`;

  return (
    <SettingsPageContainer>
      <Flex justify="between" align="start" gap="3" mb="5">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Heading
            size="5"
            weight="medium"
            style={{ color: "var(--slate-12)" }}
          >
            {label("title")}
          </Heading>
          <Text as="p" color="gray" mt="2">
            {label("subtitle")}
          </Text>
        </Box>
        <Tooltip content={label("refresh")}>
          <IconButton
            className="touch-hit"
            variant="soft"
            aria-label={label("refresh")}
            style={{ minWidth: 44, minHeight: 44 }}
            onClick={() => {
              void mutate();
              void refreshBudgets();
            }}
          >
            <MaterialIcon name="refresh" size={18} />
          </IconButton>
        </Tooltip>
      </Flex>
      {view === "personal" && profile && (
        <Flex gap="3" align="center" mb="4">
          <UserAvatar
            fullName={profile.fullName}
            email={profile.email}
            src={profile.avatarUrl}
            size={40}
          />
          <Box style={{ minWidth: 0 }}>
            <Text as="p" size="2" weight="medium" truncate>
              {profile.fullName || profile.email}
            </Text>
            <Text as="p" size="1" color="gray" truncate>
              {profile.email}
            </Text>
          </Box>
        </Flex>
      )}
      <Box mb="4">
        <SettingsSection>
          <Flex gap="2" wrap="wrap" align="center">
            <DateRangePicker
              label={`${label("from")} - ${label("to")}`}
              icon="calendar_today"
              startDate={start}
              endDate={end}
              dateType="between"
              fixedDateType="between"
              onApply={(from, to) => {
                setStart(from);
                setEnd(to || from);
                setOffset(0);
              }}
              onClear={() => {
                setStart(
                  new Date(Date.now() - 29 * 86_400_000)
                    .toISOString()
                    .slice(0, 10),
                );
                setEnd(today);
                setOffset(0);
              }}
            />
            {isAdmin && (
              <Flex direction="column" gap="1">
                <Select.Root
                  size="1"
                  value={view}
                  onValueChange={(v) => {
                    setView(v);
                    setAudience("all");
                    setFilters({});
                    setOffset(0);
                  }}
                >
                  <Select.Trigger
                    variant="surface"
                    color="gray"
                    aria-label={label("view")}
                    className="touch-hit"
                    style={{ height: 28, borderRadius: "var(--radius-2)" }}
                  >
                    {label("view")}: {label(view)}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="personal">
                      {label("personal")}
                    </Select.Item>
                    {isAdmin && (
                      <Select.Item value="organization">
                        {label("organization")}
                      </Select.Item>
                    )}
                  </Select.Content>
                </Select.Root>
              </Flex>
            )}
            <Flex direction="column" gap="1">
              <Select.Root
                size="1"
                value={interval}
                onValueChange={setInterval}
              >
                <Select.Trigger
                  variant="surface"
                  color="gray"
                  aria-label={label("interval")}
                  className="touch-hit"
                  style={{ height: 28, borderRadius: "var(--radius-2)" }}
                >
                  {label("interval")}: {label(interval)}
                </Select.Trigger>
                <Select.Content>
                  {["hour", "day", "week", "month"].map((v) => (
                    <Select.Item key={v} value={v}>
                      {label(v)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
            {isAdmin && view === "organization" && (
              <>
                <Flex direction="column" gap="1">
                  <Select.Root
                    size="1"
                    value={audience}
                    onValueChange={(value) => {
                      setAudience(value);
                      setFilters((previous) => ({ ...previous, user_id: "" }));
                      setOffset(0);
                    }}
                  >
                    <Select.Trigger
                      variant="surface"
                      color="gray"
                      aria-label={label("consumption")}
                      className="touch-hit"
                      style={{ height: 28, borderRadius: "var(--radius-2)" }}
                    >
                      {label("consumption")}:{" "}
                      {label(
                        audience === "all"
                          ? "organizationTotal"
                          : audience === "users"
                            ? "allUsers"
                            : "background",
                      )}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="all">
                        {label("organizationTotal")}
                      </Select.Item>
                      <Select.Item value="users">
                        {label("allUsers")}
                      </Select.Item>
                      <Select.Item value="services">
                        {label("background")}
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Flex>
                {audience !== "services" && filterControl("user_id")}
              </>
            )}
            {filterControl("model")}
            <Flex direction="column" justify="end">
              <Button
                className="touch-hit"
                size="1"
                variant={filtersOpen ? "solid" : "outline"}
                color={filtersOpen ? undefined : "gray"}
                style={{ height: 28, borderRadius: "var(--radius-2)" }}
                aria-expanded={filtersOpen}
                aria-controls="usage-advanced-filters"
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <MaterialIcon name="filter_list" size={16} />
                {label("filters")}
                {Object.values(filters).filter(Boolean).length > 0 &&
                  ` (${Object.values(filters).filter(Boolean).length})`}
              </Button>
            </Flex>
            <HelpTooltip
              content={label("utc")}
              open={helpOpen}
              onOpenChange={setHelpOpen}
            >
              <IconButton
                variant="ghost"
                color="gray"
                className="touch-hit"
                aria-label={label("dateHelp")}
                onClick={() => setHelpOpen((open) => !open)}
              >
                <MaterialIcon name="help_outline" size={16} />
              </IconButton>
            </HelpTooltip>
            <Flex gap="2" align="center" wrap="wrap">
              {Object.values(filters).some(Boolean) && (
                <Button
                  className="touch-hit"
                  variant="ghost"
                  onClick={() => {
                    setFilters({});
                    setOffset(0);
                  }}
                >
                  {label("clear")}
                </Button>
              )}
            </Flex>
          </Flex>
          {filtersOpen && (
            <Flex id="usage-advanced-filters" gap="2" mt="3" wrap="wrap">
              {FIELDS.filter(
                (field) => field !== "model" && field !== "user_id",
              ).map((field) => (
                <Box key={field} style={{ minWidth: 0 }}>
                  {filterControl(field)}
                </Box>
              ))}
            </Flex>
          )}
        </SettingsSection>
      </Box>
      {!validDates && (
        <Callout.Root color="amber" mb="4">
          <Callout.Text>{label("invalidRange")}</Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Callout.Root color="red" mb="4">
          <Callout.Text>{label("loadFailed")}</Callout.Text>
        </Callout.Root>
      )}
      {isLoading && (
        <Text as="p" mb="4">
          {label("loading")}
        </Text>
      )}
      {notice && (
        <Callout.Root color={saveError ? "red" : "blue"} mb="4">
          <Callout.Text>{notice}</Callout.Text>
        </Callout.Root>
      )}
      {data && (
        <>
          <Grid columns={{ initial: "2", lg: "4" }} gap="3" mb="4">
            {[
              ["tokens", number(metricValue(data.summary, "tokens"))],
              [
                "cost",
                money(
                  data.summary.requests > 0 &&
                    data.summary.unpriced_requests === data.summary.requests
                    ? null
                    : data.summary.cost_usd,
                  i18n.language,
                ),
              ],
              ["requests", number(data.summary.requests)],
              ["unpriced", number(data.summary.unpriced_requests)],
            ].map(([key, value]) => (
              <Box key={key}>
                <SettingsSection>
                  <Box>
                    <Text color="gray" size="2">
                      {label(key)}
                    </Text>
                    <Heading
                      size="5"
                      mt="2"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {value}
                    </Heading>
                  </Box>
                </SettingsSection>
              </Box>
            ))}
          </Grid>
          <Text as="p" size="1" color="gray" mb="3">
            {label("costNote")}
          </Text>
          {(data.tracking_health.failed > 0 ||
            data.tracking_health.missing_identity > 0) && (
            <Callout.Root color="amber" mb="4">
              <Callout.Text>{label("coverageGap")}</Callout.Text>
            </Callout.Root>
          )}
          {(data.summary.estimated_requests > 0 ||
            data.summary.unknown_requests > 0 ||
            data.summary.incomplete_requests > 0) && (
            <Text as="p" size="2" color="gray" mb="3">
              {label("estimated")}: {number(data.summary.estimated_requests)} ·{" "}
              {label("unknown")}: {number(data.summary.unknown_requests)} ·{" "}
              {label("incomplete")}: {number(data.summary.incomplete_requests)}
            </Text>
          )}
          <Text as="p" size="2" color="gray" mb="4">
            {label("input")}: {number(data.summary.input_tokens)} ·{" "}
            {label("output")}: {number(data.summary.output_tokens)}
          </Text>
        </>
      )}
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List style={{ flexWrap: "wrap", height: "auto" }}>
          <Tabs.Trigger
            style={{ minHeight: 44, paddingInline: 6 }}
            value="overview"
          >
            {label("overview")}
          </Tabs.Trigger>
          <Tabs.Trigger
            style={{ minHeight: 44, paddingInline: 6 }}
            value="history"
          >
            {label("history")}
          </Tabs.Trigger>
          <Tabs.Trigger
            style={{ minHeight: 44, paddingInline: 6 }}
            value="budgets"
          >
            {label("budgets")}
          </Tabs.Trigger>
          {isAdmin && (
            <Tabs.Trigger
              style={{ minHeight: 44, paddingInline: 6 }}
              value="pricing"
            >
              {label("pricing")}
            </Tabs.Trigger>
          )}
        </Tabs.List>
        <Tabs.Content value="overview">
          {data && (
            <Box mt="4" mb="4">
              <SettingsSection>
                <Flex
                  justify="between"
                  align="center"
                  wrap="wrap"
                  gap="3"
                  mb="3"
                >
                  <Heading size="3">{label("overTime")}</Heading>
                  <Select.Root
                    size="1"
                    value={metric}
                    onValueChange={(v) => setMetric(v as UsageMetric)}
                  >
                    <Select.Trigger
                      aria-label={label("metric")}
                      style={{ height: 28, borderRadius: "var(--radius-2)" }}
                    />
                    <Select.Content>
                      {["tokens", "cost", "requests"].map((v) => (
                        <Select.Item key={v} value={v}>
                          {label(v)}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Flex>
                {timeline.length > 0 &&
                Boolean(data.summary.requests) &&
                hasKnownActivity ? (
                  <>
                    <Text as="p" size="1" color="gray">
                      {display(maxTimeline)}
                    </Text>
                    <svg
                      viewBox="0 0 700 150"
                      preserveAspectRatio="none"
                      role="img"
                      aria-label={label("overTime")}
                      style={{
                        display: "block",
                        width: "100%",
                        height: 160,
                        marginTop: 8,
                      }}
                    >
                      {[15, 77.5, 140].map((y) => (
                        <line
                          key={y}
                          x1="0"
                          y1={y}
                          x2="700"
                          y2={y}
                          stroke="var(--gray-5)"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {segments.map((segment, i) =>
                        segment.length === 1 ? (
                          <circle
                            key={i}
                            cx={
                              point(segment[0].index, segment[0].value).split(
                                ",",
                              )[0]
                            }
                            cy={
                              point(segment[0].index, segment[0].value).split(
                                ",",
                              )[1]
                            }
                            r="4"
                            fill="var(--accent-9)"
                          />
                        ) : (
                          <polyline
                            key={i}
                            points={segment
                              .map(({ index, value }) => point(index, value))
                              .join(" ")}
                            fill="none"
                            stroke="var(--accent-9)"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ),
                      )}
                    </svg>
                    {[3, 5].map((count) => (
                      <Box
                        key={count}
                        display={
                          count === 3
                            ? { initial: "block", sm: "none" }
                            : { initial: "none", sm: "block" }
                        }
                        style={{ position: "relative", height: 40 }}
                      >
                        {timelineTicks(
                          timeline.map((row) => row.label),
                          interval,
                          i18n.language,
                          count,
                        ).map((tick, index) => (
                          <Box
                            key={tick.index}
                            style={{
                              position: "absolute",
                              left: `${tick.position}%`,
                              top: 0,
                              transform:
                                index === 0
                                  ? undefined
                                  : tick.position === 100
                                    ? "translateX(-100%)"
                                    : "translateX(-50%)",
                            }}
                          >
                            <Box
                              style={{
                                position: "relative",
                                height: 6,
                                marginBottom: 6,
                              }}
                            >
                              <Box
                                style={{
                                  position: "absolute",
                                  left:
                                    index === 0
                                      ? "0%"
                                      : tick.position === 100
                                        ? "100%"
                                        : "50%",
                                  height: 6,
                                  borderLeft: "1px solid var(--gray-7)",
                                }}
                              />
                            </Box>
                            <Text
                              size="1"
                              color="gray"
                              title={tick.raw}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {tick.label}
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    ))}
                    <VisuallyHidden asChild>
                      <table>
                        <caption>{label("overTime")}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{label("time")}</th>
                            <th scope="col">{label(metric)}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {timeline.map((r) => (
                            <tr key={r.label}>
                              <td>{r.label}</td>
                              <td>{display(metricValue(r, metric))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </VisuallyHidden>
                  </>
                ) : (
                  <Text as="p" mt="4" color="gray">
                    {data.summary.requests && !hasKnownActivity
                      ? "—"
                      : label("noData")}
                  </Text>
                )}
              </SettingsSection>
            </Box>
          )}
          {data && (
            <Grid columns={{ initial: "1", md: "2" }} gap="4">
              {bars(data.model, label("topModels"))}
              {bars(data?.workload ?? [], label("byWorkload"))}
              {view === "organization" && (
                <SettingsSection>
                  <Heading size="3" mb="4">
                    {label("byMember")}
                  </Heading>
                  <Box style={{ minWidth: 0 }}>
                    <EntityDataTable<Breakdown>
                      ariaLabel={label("byMember")}
                      data={data.user_id}
                      getItemId={(row) => row.id ?? "__services__"}
                      columns={[
                        {
                          key: "user_id",
                          label: label("user_id"),
                          minWidth: "180px",
                          render: (row) => (
                            <Text size="2">
                              {row.id ? row.label : label("background")}
                            </Text>
                          ),
                        },
                        {
                          key: "requests",
                          label: label("requests"),
                          minWidth: "100px",
                          render: (row) => number(row.requests),
                        },
                        {
                          key: "tokens",
                          label: label("tokens"),
                          minWidth: "100px",
                          render: (row) => number(metricValue(row, "tokens")),
                        },
                        {
                          key: "cost",
                          label: label("cost"),
                          minWidth: "140px",
                          render: (row) => (
                            <Text size="2">
                              {money(metricValue(row, "cost"), i18n.language)}
                              {row.unpriced_requests > 0 ? " *" : ""}
                            </Text>
                          ),
                        },
                      ]}
                    />
                  </Box>
                </SettingsSection>
              )}
              {bars(rows("connector_id"), label("byConnector"))}
            </Grid>
          )}
        </Tabs.Content>
        <Tabs.Content value="history">
          <Flex
            direction="column"
            mt="4"
            style={{
              height: "min(640px, 70vh)",
              minHeight: 320,
              minWidth: 0,
              overflow: "hidden",
              border: "1px solid var(--olive-3)",
              borderRadius: "var(--radius-3)",
            }}
          >
            <EntityDataTable<UsageEvent>
              ariaLabel={label("history")}
              data={data?.events ?? []}
              getItemId={(event) => event.id}
              isLoading={isLoading}
              columns={[
                {
                  key: "time",
                  label: label("time"),
                  minWidth: "180px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {new Date(event.occurred_at).toLocaleString(
                        i18n.language,
                      )}{" "}
                    </Box>
                  ),
                },
                {
                  key: "model",
                  label: label("model"),
                  minWidth: "240px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      <Text weight="medium">{event.model}</Text>
                      <Text as="p" size="1" color="gray">
                        {event.provider} ·{" "}
                        {t(`usage.${event.kind}`, { defaultValue: event.kind })}{" "}
                        · {label("units")}: {number(event.units)}
                      </Text>{" "}
                    </Box>
                  ),
                },
                {
                  key: "user_id",
                  label: label("user_id"),
                  minWidth: "180px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {event.user_label ||
                        event.user_id ||
                        label("background")}{" "}
                    </Box>
                  ),
                },
                {
                  key: "connector_id",
                  label: label("connector_id"),
                  minWidth: "160px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {event.connector_id
                        ? connectorLabel(event.connector_id)
                        : "—"}{" "}
                    </Box>
                  ),
                },
                {
                  key: "workload",
                  label: label("workload"),
                  minWidth: "160px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {event.workload}
                      <Text as="p" size="1" color="gray">
                        {event.purpose}
                      </Text>{" "}
                    </Box>
                  ),
                },
                {
                  key: "input",
                  label: label("input"),
                  minWidth: "100px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {event.measurement === "unknown"
                        ? "—"
                        : number(event.input_tokens)}{" "}
                    </Box>
                  ),
                },
                {
                  key: "output",
                  label: label("output"),
                  minWidth: "140px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {event.measurement === "unknown"
                        ? "—"
                        : number(event.output_tokens)}
                      <Text as="p" size="1" color="gray">
                        {label("reasoning")}: {number(event.reasoning_tokens)}
                      </Text>{" "}
                    </Box>
                  ),
                },
                {
                  key: "cache",
                  label: label("cache"),
                  minWidth: "100px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {number(
                        event.cache_read_tokens + event.cache_write_tokens,
                      )}{" "}
                    </Box>
                  ),
                },
                {
                  key: "cost",
                  label: label("cost"),
                  minWidth: "130px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {money(event.cost_usd, i18n.language)}
                      <Text as="p" size="1" color="gray">
                        {label(event.pricing_source)}
                      </Text>{" "}
                    </Box>
                  ),
                },
                {
                  key: "measurement",
                  label: label("measurement"),
                  minWidth: "130px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {label(event.measurement)}{" "}
                    </Box>
                  ),
                },
                {
                  key: "status",
                  label: label("status"),
                  minWidth: "100px",
                  render: (event) => (
                    <Box style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {" "}
                      {label(event.status)}{" "}
                    </Box>
                  ),
                },
              ]}
            />
            {data && !data.events.length && (
              <Text size="2" color="gray" m="3">
                {label("noData")}
              </Text>
            )}
            <EntityPagination
              page={Math.floor(offset / pageSize) + 1}
              limit={pageSize}
              totalCount={data?.summary.requests ?? 0}
              onPageChange={(page) => setOffset((page - 1) * pageSize)}
              onLimitChange={(limit) => {
                setPageSize(limit);
                setOffset(0);
              }}
            />
          </Flex>
        </Tabs.Content>
        <Tabs.Content value="budgets">
          <Callout.Root color="blue" mt="4" mb="4">
            <Callout.Text>{label("budgetNote")}</Callout.Text>
          </Callout.Root>
          {budgetError && <Text color="red">{label("loadFailed")}</Text>}
          <Grid columns={{ initial: "1", md: "2" }} gap="3">
            {budgetData?.budgets.map((budget) => (
              <Box key={budget.id}>
                <SettingsSection>
                  <Box>
                    <Flex justify="between" gap="2">
                      <Heading size="3">
                        {targetLabel(budget.scope, budget.subject)}
                      </Heading>
                      {isAdmin && (
                        <Button
                          className="touch-hit"
                          size="1"
                          variant="ghost"
                          color="red"
                          disabled={saving}
                          onClick={() =>
                            void save(
                              () => usageApi.deleteBudget(budget.id),
                              refreshBudgets,
                            )
                          }
                        >
                          {label("remove")}
                        </Button>
                      )}
                    </Flex>
                    <Text as="p" mt="3">
                      {money(budget.spent_usd, i18n.language)} /{" "}
                      {money(budget.amount_usd, i18n.language)} (
                      {number(budget.percent)}%)
                    </Text>
                    <Box
                      role="progressbar"
                      aria-label={targetLabel(budget.scope, budget.subject)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(100, budget.percent)}
                      style={{
                        height: 10,
                        background: "var(--gray-4)",
                        borderRadius: "var(--radius-2)",
                        margin: "12px 0",
                      }}
                    >
                      <Box
                        style={{
                          height: "100%",
                          width: `${Math.min(100, budget.percent)}%`,
                          borderRadius: "inherit",
                          background:
                            budget.state === "exceeded"
                              ? "var(--red-9)"
                              : budget.state === "warning"
                                ? "var(--amber-9)"
                                : "var(--accent-9)",
                        }}
                      />
                    </Box>
                    <Text size="2">
                      {label(budget.state)} · {label("unpriced")}:{" "}
                      {number(budget.unpriced_requests)}
                    </Text>
                  </Box>
                </SettingsSection>
              </Box>
            ))}
          </Grid>
          {budgetsLoading && (
            <Text as="p" mt="4" color="gray">
              {label("loading")}
            </Text>
          )}
          {budgetData && !budgetData.budgets.length && !budgetError && (
            <Text as="p" mt="4" color="gray">
              {label("noBudgets")}
            </Text>
          )}
          {isAdmin && view === "personal" && (
            <Button
              className="touch-hit"
              mt="3"
              onClick={() => {
                setView("organization");
                setFilters({});
                setOffset(0);
              }}
            >
              {label("setBudget")}
            </Button>
          )}
          {isAdmin && view === "organization" && (
            <Box mt="4">
              <SettingsSection>
                <Box>
                  <Heading size="3" mb="3">
                    {label("setBudget")}
                  </Heading>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void save(
                        () =>
                          usageApi.saveBudget({
                            scope: budgetScope,
                            subject: budgetSubject,
                            amount_usd: budgetAmount,
                            warning_percent: Number(warning),
                          }),
                        refreshBudgets,
                      );
                    }}
                  >
                    <Grid columns={{ initial: "1", md: "2" }} gap="3">
                      <Select.Root
                        value={budgetScope}
                        onValueChange={(v) => {
                          setBudgetScope(v);
                          setBudgetSubject("");
                        }}
                      >
                        <Select.Trigger aria-label={label("scope")} />
                        <Select.Content>
                          {[
                            "organization",
                            "user_id",
                            "connector_id",
                            "model",
                          ].map((v) => (
                            <Select.Item key={v} value={v}>
                              {label(v)}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Root>
                      {budgetScope !== "organization" && (
                        <Select.Root
                          value={budgetSubject}
                          onValueChange={setBudgetSubject}
                        >
                          <Select.Trigger
                            aria-label={label("target")}
                            placeholder={label("target")}
                          />
                          <Select.Content>
                            {rows(budgetScope)
                              .filter((r) => r.id)
                              .map((r) => (
                                <Select.Item key={r.id} value={r.id!}>
                                  {r.label}
                                </Select.Item>
                              ))}
                          </Select.Content>
                        </Select.Root>
                      )}
                      <label>
                        <Text size="2">{label("monthlyUsd")}</Text>
                        <TextField.Root
                          required
                          type="number"
                          min="0.01"
                          max="1000000000"
                          step="0.01"
                          value={budgetAmount}
                          onChange={(e) => setBudgetAmount(e.target.value)}
                        />
                      </label>
                      <label>
                        <Text size="2">{label("warningPercent")}</Text>
                        <TextField.Root
                          required
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          value={warning}
                          onChange={(e) => setWarning(e.target.value)}
                        />
                      </label>
                    </Grid>
                    <Button
                      className="touch-hit"
                      type="submit"
                      mt="3"
                      disabled={
                        saving ||
                        (budgetScope !== "organization" && !budgetSubject)
                      }
                    >
                      {label("save")}
                    </Button>
                  </form>
                </Box>
              </SettingsSection>
            </Box>
          )}
        </Tabs.Content>
        {isAdmin && (
          <Tabs.Content value="pricing">
            <Callout.Root color="blue" mt="4" mb="4">
              <Callout.Text>{label("pricingNote")}</Callout.Text>
            </Callout.Root>
            {rateError && <Text color="red">{label("loadFailed")}</Text>}
            <SettingsSection>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(() => usageApi.saveRate(rate), refreshRates);
                }}
              >
                <Grid columns={{ initial: "1", md: "2" }} gap="3">
                  <label>
                    <Text size="2">{label("provider")}</Text>
                    <TextField.Root
                      required
                      maxLength={200}
                      list="usage-provider-list"
                      value={rate.provider}
                      onChange={(e) =>
                        setRate({ ...rate, provider: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    <Text size="2">{label("model")}</Text>
                    <TextField.Root
                      required
                      maxLength={200}
                      list="usage-model-list"
                      value={rate.model}
                      onChange={(e) =>
                        setRate({ ...rate, model: e.target.value })
                      }
                    />
                  </label>
                  {RATE_FIELDS.map((field) => (
                    <label key={field}>
                      <Text size="2">{label(field)}</Text>
                      <TextField.Root
                        required
                        type="number"
                        min="0"
                        max="100000"
                        step="any"
                        value={rate.rates[field]}
                        onChange={(e) =>
                          setRate({
                            ...rate,
                            rates: { ...rate.rates, [field]: e.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                </Grid>
                <datalist id="usage-provider-list">
                  {data?.provider.map((r) => (
                    <option key={r.id} value={r.id!} />
                  ))}
                </datalist>
                <datalist id="usage-model-list">
                  {data?.model.map((r) => (
                    <option key={r.id} value={r.id!} />
                  ))}
                </datalist>
                <Button type="submit" mt="3" disabled={saving}>
                  {label("save")}
                </Button>
              </form>
            </SettingsSection>
            <Box mt="4" style={{ minWidth: 0 }}>
              <EntityDataTable<Rate>
                ariaLabel={label("pricing")}
                data={rateData?.rates ?? []}
                getItemId={(row) => `${row.provider}/${row.model}`}
                columns={[
                  {
                    key: "provider",
                    label: label("provider"),
                    minWidth: "140px",
                    render: (row) => row.provider,
                  },
                  {
                    key: "model",
                    label: label("model"),
                    minWidth: "220px",
                    render: (row) => (
                      <Button variant="ghost" onClick={() => setRate(row)}>
                        {row.model}
                      </Button>
                    ),
                  },
                  ...RATE_FIELDS.map((field) => ({
                    key: field,
                    label: label(field),
                    minWidth: "110px",
                    render: (row: Rate) => row.rates[field],
                  })),
                ]}
                renderRowActions={(row) => (
                  <EntityRowActionMenu
                    actions={[
                      {
                        icon: "restart_alt",
                        label: label("useCatalog"),
                        disabled: saving,
                        onClick: () =>
                          save(
                            () => usageApi.resetRate(row.provider, row.model),
                            refreshRates,
                          ),
                      },
                    ]}
                  />
                )}
              />
            </Box>
          </Tabs.Content>
        )}
      </Tabs.Root>
    </SettingsPageContainer>
  );
}
