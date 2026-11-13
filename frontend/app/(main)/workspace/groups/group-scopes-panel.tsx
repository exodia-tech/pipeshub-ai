'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Button, Callout, Flex, IconButton, Switch, Text } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { ScopeCheckboxList } from '../components';
import { HelpTooltip } from '@/app/components/ui/help-tooltip';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { captureSession, onSessionEnd } from '@/lib/api/session-cache';
import { getUserFacingErrorMessage } from '@/lib/api/api-error';
import { AccessGroupsApi, type ResourcePolicy } from './access-api';

export function GroupScopesPanel({ groupId, onDirtyChange, onBusyChange }: {
  groupId: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data: policy, error, mutate } = useSWR(['group-resource-policy', groupId], () => AccessGroupsApi.policy(groupId));
  const { data: scopes, error: scopeError } = useSWR('group-feature-scope-catalog', AccessGroupsApi.scopes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ResourcePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const value = (draft ?? policy)?.featureScopes ?? null;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(policy);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => onSessionEnd(() => { setDraft(null); setEditing(false); setBusy(false); setFailure(''); setHelpOpen(false); }), []);
  const save = async () => {
    if (!draft || !dirty || busy) return;
    const current = captureSession();
    setBusy(true); setFailure('');
    try {
      await AccessGroupsApi.savePolicy(groupId, draft);
      if (current()) { await mutate(); if (current()) { setDraft(null); setEditing(false); } }
    } catch (error) {
      if (current()) setFailure(getUserFacingErrorMessage(error, t('accessGroups.error')));
    } finally { if (current()) setBusy(false); }
  };
  if (error || scopeError) return <Callout.Root color="red"><Callout.Text>{t('accessGroups.error')}</Callout.Text></Callout.Root>;
  if (!policy || !scopes) return <Text size="2" color="gray">{t('common.loading')}</Text>;
  const selected = new Set(value ?? scopes.map((scope) => scope.name));
  const groups = [...new Set(scopes.map((scope) => scope.category))].map((category): [string, typeof scopes] => [category, scopes.filter((scope) => scope.category === category)]);
  const change = (names: string[], checked: boolean) => {
    const next = new Set(selected);
    names.forEach((name) => { if (checked) next.add(name); else next.delete(name); });
    setDraft({ ...(draft ?? policy), featureScopes: scopes.filter((scope) => next.has(scope.name)).map((scope) => scope.name) });
  };
  return <Flex direction="column" gap="4">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Flex align="center" gap="2">
        <Switch className="touch-hit" id={`limit-${groupId}`} checked={value !== null} disabled={!editing || busy}
          onCheckedChange={(checked) => setDraft({ ...(draft ?? policy), featureScopes: checked ? scopes.map((scope) => scope.name) : null })} />
        <Text as="label" htmlFor={`limit-${groupId}`} size="2">{t('groupScopes.limit')}</Text>
        <HelpTooltip content={t('groupScopes.help')} open={helpOpen} onOpenChange={setHelpOpen}>
          <IconButton className="touch-hit" variant="ghost" color="gray" aria-label={t('groupScopes.about')} onClick={() => setHelpOpen(!helpOpen)}><MaterialIcon name="help_outline" size={18} /></IconButton>
        </HelpTooltip>
      </Flex>
      {!editing && <Button className="touch-size" variant="soft" onClick={() => { setDraft(policy); setEditing(true); }}>{t('workspace.groups.actions.managePermissions')}</Button>}
    </Flex>
    <Text size="2" color="gray">{t(value === null ? 'groupScopes.unrestricted' : 'groupScopes.selected', { count: selected.size })}</Text>
    {failure && <Callout.Root color="red"><Callout.Text>{failure}</Callout.Text></Callout.Root>}
    {value !== null && <ScopeCheckboxList groups={groups} selected={selected} disabled={!editing || busy}
      onScopeChange={(name, checked) => change([name], checked)} onCategoryChange={(items, checked) => change(items.map((item) => item.name), checked)} />}
    {editing && <Flex gap="2" justify="end">
      <Button className="touch-size" variant="soft" color="gray" disabled={busy} onClick={() => { setDraft(null); setEditing(false); setFailure(''); }}>{t('common.cancel')}</Button>
      <Button className="touch-size" disabled={!dirty || busy} loading={busy} onClick={() => void save()}>{t('common.save')}</Button>
    </Flex>}
  </Flex>;
}
