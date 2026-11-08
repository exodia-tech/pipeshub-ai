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
  Card,
  Button,
  IconButton,
  Tooltip,
  Select,
  Tabs,
  TextField,
  Table,
  Callout,
  VisuallyHidden,
} from "@radix-ui/themes";
import { MaterialIcon } from "@/app/components/ui/MaterialIcon";
import { useUserStore, selectIsAdmin } from "@/lib/store/user-store";
import { onSessionEnd } from "@/lib/api/session-cache";
import { ConnectorsApi } from "../connectors/api";
import { usageApi, type Breakdown, type Rate } from "./api";
import {
  exclusiveEnd,
  chartMaximum,
  metricValue,
  money,
  seriesSegments,
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
const inputStyle = {
  background: "var(--color-surface)",
  color: "var(--gray-12)",
  border: "1px solid var(--gray-6)",
  borderRadius: "var(--radius-2)",
  padding: "0 10px",
  height: 44,
  minWidth: 0,
  boxSizing: "border-box" as const,
  font: "inherit",
  width: "100%",
};

export default function UsagePage() {
  const { t, i18n } = useTranslation();
  const isAdmin = useUserStore(selectIsAdmin);
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(() =>
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  );
  const [end, setEnd] = useState(today);
  const [view, setView] = useState("personal");
  const [tab, setTab] = useState("overview");
  const [interval, setInterval] = useState("day");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
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
    from: `${start}T00:00:00Z`,
    to: validDates ? exclusiveEnd(end) : "",
    offset,
    limit: 50,
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
    (data?.[field as (typeof FIELDS)[number]] ?? []).map((row) =>
      field === "connector_id" && row.id
        ? { ...row, label: connectorLabel(row.id) }
        : row,
    );
  const filterControl = (field: (typeof FIELDS)[number]) => (
    <Flex direction="column" gap="1">
      <Text size="2">{label(field)}</Text>
      <Select.Root
        value={filters[field] || "__all__"}
        onValueChange={(v) => updateFilter(field, v)}
      >
        <Select.Trigger
          aria-label={label(field)}
          style={{ minHeight: 44, width: "100%", minWidth: 0 }}
        />
        <Select.Content>
          <Select.Item value="__all__">{label("all")}</Select.Item>
          {(field === "user_id" || field === "connector_id") &&
            rows(field).some((r) => r.id === null) && (
              <Select.Item value="__none__">
                {label(field === "user_id" ? "background" : "noConnector")}
              </Select.Item>
            )}
          {rows(field)
            .filter((r) => r.id)
            .map((r) => (
              <Select.Item key={r.id} value={r.id!}>
                {r.label}
              </Select.Item>
            ))}
          {filters[field] &&
            filters[field] !== "__none__" &&
            !rows(field).some((r) => r.id === filters[field]) && (
              <Select.Item value={filters[field]}>{filters[field]}</Select.Item>
            )}
        </Select.Content>
      </Select.Root>
    </Flex>
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
      <Card>
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
      </Card>
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
    <Box
      p={{ initial: "4", md: "6" }}
      style={{ width: "100%", maxWidth: 1600, margin: "0 auto" }}
    >
      <Flex justify="between" align="start" gap="3" mb="4">
        <Box pl={{ initial: "6", md: "0" }} style={{ flex: 1, minWidth: 0 }}>
          <Heading size="6">{label("title")}</Heading>
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
      <Card mb="4">
        <Grid columns={{ initial: "2", md: "3", lg: "6" }} gap="3">
          <Flex direction="column" gap="1">
            <Text as="label" htmlFor="usage-from" size="2">
              {label("from")}
            </Text>
            <input
              id="usage-from"
              type="date"
              value={start}
              max={end}
              style={inputStyle}
              onChange={(e) => {
                setStart(e.target.value);
                setOffset(0);
              }}
            />
          </Flex>
          <Flex direction="column" gap="1">
            <Text as="label" htmlFor="usage-to" size="2">
              {label("to")}
            </Text>
            <input
              id="usage-to"
              type="date"
              value={end}
              min={start}
              max={today}
              style={inputStyle}
              onChange={(e) => {
                setEnd(e.target.value);
                setOffset(0);
              }}
            />
          </Flex>
          {isAdmin && (
            <Flex direction="column" gap="1">
              <Text size="2">{label("view")}</Text>
              <Select.Root
                value={view}
                onValueChange={(v) => {
                  setView(v);
                  setFilters({});
                  setOffset(0);
                }}
              >
                <Select.Trigger
                  aria-label={label("view")}
                  style={{ minHeight: 44 }}
                />
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
            <Text size="2">{label("interval")}</Text>
            <Select.Root value={interval} onValueChange={setInterval}>
              <Select.Trigger
                aria-label={label("interval")}
                style={{ minHeight: 44 }}
              />
              <Select.Content>
                {["hour", "day", "week", "month"].map((v) => (
                  <Select.Item key={v} value={v}>
                    {label(v)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
          {filterControl("model")}
          <Flex direction="column" justify="end">
            <Button
              className="touch-hit"
              variant={filtersOpen ? "solid" : "soft"}
              style={{ minHeight: 44, width: "100%" }}
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
        </Grid>
        <Flex mt="3" justify="between" align="center" wrap="wrap" gap="2">
          <Text size="1" color="gray">
            {label("utc")}
          </Text>
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
          <Grid
            id="usage-advanced-filters"
            columns={{ initial: "2", md: "3", lg: "4" }}
            gap="3"
            mt="4"
          >
            {FIELDS.filter(
              (field) =>
                field !== "model" &&
                (view === "organization" || field !== "user_id"),
            ).map((field) => (
              <Box key={field} style={{ minWidth: 0 }}>
                {filterControl(field)}
              </Box>
            ))}
          </Grid>
        )}
      </Card>
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
              <Card key={key}>
                <Text color="gray" size="2">
                  {label(key)}
                </Text>
                <Heading size="5" mt="2" style={{ overflowWrap: "anywhere" }}>
                  {value}
                </Heading>
              </Card>
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
            <Card mt="4" mb="4">
              <Flex justify="between" align="center" wrap="wrap" gap="3" mb="3">
                <Heading size="3">{label("overTime")}</Heading>
                <Select.Root
                  value={metric}
                  onValueChange={(v) => setMetric(v as UsageMetric)}
                >
                  <Select.Trigger
                    aria-label={label("metric")}
                    style={{ minHeight: 44 }}
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
                  <Flex justify="between" gap="3" mt="2">
                    <Text size="1" color="gray">
                      {timeline[0].label}
                    </Text>
                    {timeline.length > 1 && (
                      <Text size="1" color="gray" align="right">
                        {timeline[timeline.length - 1].label}
                      </Text>
                    )}
                  </Flex>
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
            </Card>
          )}
          {data && (
            <Grid columns={{ initial: "1", md: "2" }} gap="4">
              {bars(data.model, label("topModels"))}
              {bars(data?.workload ?? [], label("byWorkload"))}
              {view === "organization" &&
                bars(data?.user_id ?? [], label("byMember"))}
              {bars(rows("connector_id"), label("byConnector"))}
            </Grid>
          )}
        </Tabs.Content>
        <Tabs.Content value="history">
          <Box mt="4" style={{ overflowX: "auto" }}>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  {[
                    "time",
                    "model",
                    "user_id",
                    "connector_id",
                    "workload",
                    "input",
                    "output",
                    "cache",
                    "cost",
                    "measurement",
                    "status",
                  ].map((v) => (
                    <Table.ColumnHeaderCell key={v}>
                      {label(v)}
                    </Table.ColumnHeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data?.events.map((event) => (
                  <Table.Row key={event.id}>
                    <Table.Cell style={{ whiteSpace: "nowrap" }}>
                      {new Date(event.occurred_at).toLocaleString(
                        i18n.language,
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <Text weight="medium">{event.model}</Text>
                      <Text as="p" size="1" color="gray">
                        {event.provider} · {event.kind} · {label("units")}:{" "}
                        {number(event.units)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      {event.user_label || event.user_id || label("background")}
                    </Table.Cell>
                    <Table.Cell>
                      {event.connector_id
                        ? connectorLabel(event.connector_id)
                        : "—"}
                    </Table.Cell>
                    <Table.Cell>
                      {event.workload}
                      <Text as="p" size="1" color="gray">
                        {event.purpose}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      {event.measurement === "unknown"
                        ? "—"
                        : number(event.input_tokens)}
                    </Table.Cell>
                    <Table.Cell>
                      {event.measurement === "unknown"
                        ? "—"
                        : number(event.output_tokens)}
                      <Text as="p" size="1" color="gray">
                        {label("reasoning")}: {number(event.reasoning_tokens)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      {number(
                        event.cache_read_tokens + event.cache_write_tokens,
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {money(event.cost_usd, i18n.language)}
                      <Text as="p" size="1" color="gray">
                        {label(event.pricing_source)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>{label(event.measurement)}</Table.Cell>
                    <Table.Cell>{label(event.status)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
          <Flex mt="4" gap="3" align="center">
            <Button
              className="touch-hit"
              variant="soft"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              {label("previous")}
            </Button>
            <Text size="2">
              {offset + (data?.events.length ? 1 : 0)}–
              {offset + (data?.events.length ?? 0)} /{" "}
              {number(data?.summary.requests ?? 0)}
            </Text>
            <Button
              className="touch-hit"
              variant="soft"
              disabled={!data || offset + 50 >= data.summary.requests}
              onClick={() => setOffset(offset + 50)}
            >
              {label("next")}
            </Button>
          </Flex>
        </Tabs.Content>
        <Tabs.Content value="budgets">
          <Callout.Root color="blue" mt="4" mb="4">
            <Callout.Text>{label("budgetNote")}</Callout.Text>
          </Callout.Root>
          {budgetError && <Text color="red">{label("loadFailed")}</Text>}
          <Grid columns={{ initial: "1", md: "2" }} gap="3">
            {budgetData?.budgets.map((budget) => (
              <Card key={budget.id}>
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
              </Card>
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
            <Card mt="4">
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
                    <Select.Trigger
                      aria-label={label("scope")}
                      style={{ minHeight: 44 }}
                    />
                    <Select.Content>
                      {["organization", "user_id", "connector_id", "model"].map(
                        (v) => (
                          <Select.Item key={v} value={v}>
                            {label(v)}
                          </Select.Item>
                        ),
                      )}
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
                        style={{ minHeight: 44 }}
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
                    saving || (budgetScope !== "organization" && !budgetSubject)
                  }
                >
                  {label("save")}
                </Button>
              </form>
            </Card>
          )}
        </Tabs.Content>
        {isAdmin && (
          <Tabs.Content value="pricing">
            <Callout.Root color="blue" mt="4" mb="4">
              <Callout.Text>{label("pricingNote")}</Callout.Text>
            </Callout.Root>
            {rateError && <Text color="red">{label("loadFailed")}</Text>}
            <Card>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(() => usageApi.saveRate(rate), refreshRates);
                }}
              >
                <Grid columns={{ initial: "1", md: "2" }} gap="3">
                  <label>
                    <Text size="2">{label("provider")}</Text>
                    <input
                      required
                      maxLength={200}
                      list="usage-provider-list"
                      value={rate.provider}
                      onChange={(e) =>
                        setRate({ ...rate, provider: e.target.value })
                      }
                      style={inputStyle}
                    />
                  </label>
                  <label>
                    <Text size="2">{label("model")}</Text>
                    <input
                      required
                      maxLength={200}
                      list="usage-model-list"
                      value={rate.model}
                      onChange={(e) =>
                        setRate({ ...rate, model: e.target.value })
                      }
                      style={inputStyle}
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
            </Card>
            <Box mt="4" style={{ overflowX: "auto" }}>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    {["provider", "model", ...RATE_FIELDS].map((f) => (
                      <Table.ColumnHeaderCell key={f}>
                        {label(f)}
                      </Table.ColumnHeaderCell>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rateData?.rates.map((r) => (
                    <Table.Row key={`${r.provider}/${r.model}`}>
                      <Table.Cell>{r.provider}</Table.Cell>
                      <Table.Cell>
                        <Button variant="ghost" onClick={() => setRate(r)}>
                          {r.model}
                        </Button>
                        <Button
                          className="touch-hit"
                          variant="soft"
                          size="1"
                          ml="3"
                          disabled={saving}
                          onClick={() =>
                            void save(
                              () => usageApi.resetRate(r.provider, r.model),
                              refreshRates,
                            )
                          }
                        >
                          {label("useCatalog")}
                        </Button>
                      </Table.Cell>
                      {RATE_FIELDS.map((f) => (
                        <Table.Cell key={f}>{r.rates[f]}</Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          </Tabs.Content>
        )}
      </Tabs.Root>
    </Box>
  );
}
