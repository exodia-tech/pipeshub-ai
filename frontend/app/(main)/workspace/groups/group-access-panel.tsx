"use client";

import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Flex,
  Switch,
  Text,
} from "@radix-ui/themes";
import { useTranslation } from "react-i18next";
import { MaterialIcon } from "@/app/components/ui/MaterialIcon";
import { captureSession, onSessionEnd } from "@/lib/api/session-cache";
import { SelectDropdown } from "../components";
import { AccessGroupsApi, type ResourcePolicy } from "./access-api";

type DraftPolicy = Omit<ResourcePolicy, "rules"> & {
  rules: (ResourcePolicy["rules"][number] & { path?: string[] })[];
};

function ResourceBranch({
  groupId,
  parent,
  path,
  policy,
  editing,
  change,
}: {
  groupId: string;
  parent?: string;
  path: string[];
  policy: DraftPolicy;
  editing: boolean;
  change: (
    ref: string,
    allow: boolean | null,
    descendants: string[],
    path: string[],
  ) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [skip, setSkip] = useState(0);
  const { data, error, isLoading } = useSWR(
    ["group-resources", groupId, parent, skip],
    () => AccessGroupsApi.resources(groupId, parent, skip),
  );
  if (error)
    return (
      <Text role="alert" size="2" color="red">
        {t("accessGroups.error")}
      </Text>
    );
  if (isLoading)
    return (
      <Text size="2" color="gray">
        {t("common.loading")}
      </Text>
    );
  const rules = new Map(policy.rules.map((rule) => [rule.ref, rule.allow]));
  const allowed = (ref: string) => {
    for (const current of [ref, ...path.slice().reverse()])
      if (rules.has(current)) return rules.get(current)!;
    return policy.defaultAllow;
  };
  const nodes = (data?.nodes ?? []).filter(
    (node) =>
      editing ||
      (!node.allowed && node.navigable && node.kind !== "record") ||
      (allowed(node.ref) && node.readableMembers !== 0),
  );
  return (
    <Flex direction="column" gap="1">
      {!nodes.length && (
        <Text size="2" color="gray" style={{ padding: 8 }}>
          {t("groupAccess.empty")}
        </Text>
      )}
      {nodes.map((node) => {
        const descendants = policy.rules.filter(
          (rule) =>
            node.descendantRuleRefs?.includes(rule.ref) ||
            rule.path?.includes(node.ref),
        );
        const partial = descendants.some(
          (rule) => rule.allow !== allowed(node.ref),
        );
        const containsAllowed =
          !allowed(node.ref) && descendants.some((rule) => rule.allow);
        return (
          <Box key={node.ref}>
            <Flex
              direction="column"
              gap="2"
              py="2"
              style={{
                minHeight: 44,
                borderBottom: "1px solid var(--olive-3)",
              }}
            >
              <Flex
                align="center"
                gap="2"
                style={{ width: "100%", minWidth: 0 }}
              >
                {node.kind !== "record" ? (
                  <Button
                    variant="ghost"
                    size="1"
                    className="touch-hit"
                    aria-label={`${t("groupAccess.expand")} ${node.name}`}
                    onClick={() =>
                      setExpanded((old) => {
                        const next = new Set(old);
                        if (next.has(node.ref)) next.delete(node.ref);
                        else next.add(node.ref);
                        return next;
                      })
                    }
                  >
                    <MaterialIcon
                      name={
                        expanded.has(node.ref) ? "expand_more" : "chevron_right"
                      }
                      size={18}
                    />
                  </Button>
                ) : (
                  <Box width="24px" />
                )}
                {editing && (
                  <Checkbox
                    className="touch-hit"
                    aria-label={`${t("groupAccess.allow")} ${node.name}`}
                    checked={partial ? "indeterminate" : allowed(node.ref)}
                    onCheckedChange={(checked) =>
                      change(
                        node.ref,
                        checked === true,
                        descendants.map((rule) => rule.ref),
                        path,
                      )
                    }
                  />
                )}
                <MaterialIcon
                  name={
                    node.kind === "connector"
                      ? "hub"
                      : node.kind === "container"
                        ? "folder"
                        : "description"
                  }
                  size={18}
                  color="var(--slate-10)"
                />
                <Text
                  size="2"
                  style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
                >
                  {node.name}
                </Text>
              </Flex>
              <Flex align="center" gap="2" wrap="wrap" pl="5">
                <Badge
                  color={
                    (allowed(node.ref) && node.readableMembers !== 0) ||
                    containsAllowed
                      ? "blue"
                      : "gray"
                  }
                  variant="soft"
                >
                  {t(
                    partial
                      ? "groupAccess.partial"
                      : allowed(node.ref) && node.readableMembers === 0
                        ? "groupAccess.noReaders"
                        : allowed(node.ref)
                          ? "groupAccess.allowed"
                          : "groupAccess.blocked",
                  )}
                </Badge>
                {!rules.has(node.ref) && (
                  <Text size="1" color="gray">
                    {t("groupAccess.inherited")}
                  </Text>
                )}
                <Text size="1" color="gray">
                  {t("groupAccess.currentAccess")}:{" "}
                  {node.readableMembers === null
                    ? "—"
                    : `${node.readableMembers}/${data?.memberCount}`}
                </Text>
                {editing && rules.has(node.ref) && (
                  <Button
                    variant="ghost"
                    size="1"
                    onClick={() => change(node.ref, null, [], path)}
                  >
                    {t("groupAccess.reset")}
                  </Button>
                )}
              </Flex>
            </Flex>
            {expanded.has(node.ref) && (
              <Box
                pl="4"
                style={{
                  borderLeft: "1px solid var(--olive-4)",
                  marginLeft: 12,
                }}
              >
                <ResourceBranch
                  groupId={groupId}
                  parent={node.ref}
                  path={[...path, node.ref]}
                  policy={policy}
                  editing={editing}
                  change={change}
                />
              </Box>
            )}
          </Box>
        );
      })}
      {(skip > 0 || data?.hasMore) && (
        <Flex gap="2" justify="end" py="2">
          <Button
            variant="soft"
            disabled={!skip}
            onClick={() => setSkip(Math.max(0, skip - 50))}
          >
            {t("accessGroups.previous")}
          </Button>
          <Button
            variant="soft"
            disabled={!data?.hasMore}
            onClick={() => setSkip(skip + 50)}
          >
            {t("accessGroups.next")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

export function GroupAccessPanel({
  groupId,
  onDirtyChange,
}: {
  groupId: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const { mutate: refreshResources } = useSWRConfig();
  const { data, error, mutate } = useSWR(
    ["group-resource-policy", groupId],
    () => AccessGroupsApi.policy(groupId),
  );
  const [draft, setDraft] = useState<DraftPolicy | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(
    () =>
      onSessionEnd(() => {
        setDraft(null);
        setEditing(false);
        setFailed(false);
      }),
    [],
  );
  const policy = draft ?? data;
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(data);
  useEffect(() => {
    onDirtyChange?.(!!dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const save = async () => {
    if (!policy || busy) return;
    const current = captureSession();
    setBusy(true);
    setFailed(false);
    try {
      await AccessGroupsApi.savePolicy(groupId, {
        ...policy,
        rules: policy.rules.map(({ ref, allow }) => ({ ref, allow })),
      });
      if (current()) {
        await mutate();
        setDraft(null);
        setEditing(false);
        await refreshResources(
          (key) =>
            Array.isArray(key) &&
            key[0] === "group-resources" &&
            key[1] === groupId,
        );
      }
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (error || failed)
    return (
      <Callout.Root color="red">
        <Callout.Text>{t("accessGroups.error")}</Callout.Text>
        <Button
          variant="soft"
          onClick={() => {
            setFailed(false);
            void mutate();
          }}
        >
          {t("common.errorBoundary.retry")}
        </Button>
      </Callout.Root>
    );
  if (!policy) return <Text>{t("common.loading")}</Text>;
  return (
    <Flex direction="column" gap="4">
      <Text size="2" color="gray">
        {t("groupAccess.description")}
      </Text>
      <Text size="1" color="gray">
        {t("groupAccess.countsHint")}
      </Text>
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <Badge color="blue">
          {t(
            policy.defaultAllow
              ? policy.rules.some((rule) => !rule.allow)
                ? "groupAccess.allWithExceptions"
                : "groupAccess.all"
              : "groupAccess.selected",
          )}
        </Badge>
        <Text as="label" size="2">
          <Flex align="center" gap="2">
            <Switch
              checked={editing}
              disabled={busy || !!dirty}
              onCheckedChange={setEditing}
            />
            {t("groupAccess.manage")}
          </Flex>
        </Text>
      </Flex>
      {editing && (
        <SelectDropdown
          value={policy.defaultAllow ? "all" : "selected"}
          onChange={(value) =>
            setDraft({ ...policy, defaultAllow: value === "all" })
          }
          options={[
            { value: "all", label: t("groupAccess.all") },
            { value: "selected", label: t("groupAccess.selected") },
          ]}
        />
      )}
      <Box
        p="3"
        style={{
          background: "var(--olive-2)",
          border: "1px solid var(--olive-3)",
          borderRadius: "var(--radius-2)",
        }}
      >
        <ResourceBranch
          groupId={groupId}
          path={[]}
          policy={policy}
          editing={editing && !busy}
          change={(ref, allow, descendants, path) =>
            setDraft({
              ...policy,
              rules: [
                ...policy.rules.filter(
                  (rule) => rule.ref !== ref && !descendants.includes(rule.ref),
                ),
                ...(allow === null ? [] : [{ ref, allow, path }]),
              ],
            })
          }
        />
      </Box>
      {dirty && (
        <Flex gap="2" justify="end">
          <Button variant="soft" disabled={busy} onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {t("workspace.groups.permissions.save")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}
