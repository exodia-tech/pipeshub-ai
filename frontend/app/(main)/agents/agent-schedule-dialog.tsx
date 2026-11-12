'use client';

import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Checkbox, Dialog, Flex, Heading, Select, Switch, Text, TextArea, TextField } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { getUserFacingErrorMessage } from '@/lib/api/api-error';
import { AgentSchedulesApi, type AgentSchedule, type AgentScheduleSettings } from './schedule-api';
import { parseSlackChannel } from './slack-channel';

export function AgentScheduleDialog({ agentId, open, onOpenChange }: {
  agentId: string; open: boolean; onOpenChange: (value: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [saved, setSaved] = useState<AgentSchedule | null>(null);
  const [form, setForm] = useState<AgentScheduleSettings>({ enabled: false, days: [1, 3, 5], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: '' });
  const [time, setTime] = useState('09:00');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [channel, setChannel] = useState('');
  const [delivery, setDelivery] = useState<{ canManage: boolean; bots: { id: string; name: string }[] } | null>(null);
  const [deliveryError, setDeliveryError] = useState(false);
  const hydrate = useCallback((schedule: AgentSchedule) => {
    setSaved(schedule); setForm(schedule);
    setTime(`${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`);
    setDeliveryEnabled(Boolean(schedule.slackBotId || schedule.slackChannelId));
    setChannel(schedule.slackChannelId ?? '');
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setDelivery(null); setDeliveryError(false); setError('');
    void AgentSchedulesApi.deliveryOptions(agentId).then(options => { if (!cancelled) setDelivery(options); })
      .catch(() => { if (!cancelled) setDeliveryError(true); });
    AgentSchedulesApi.read(agentId).then(schedule => {
      if (cancelled) return;
      if (schedule) hydrate(schedule);
      else {
        setSaved(null); setForm({ enabled: false, days: [1, 3, 5], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: '' });
        setTime('09:00'); setDeliveryEnabled(false); setChannel('');
      }
    }).catch(reason => { if (!cancelled) { setLoadFailed(true); setError(getUserFacingErrorMessage(reason, t('agentSchedule.failed'))); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, t, hydrate]);

  const act = async (run: boolean) => {
    setError(''); setBusy(true);
    let submitted = false;
    try {
      if (run) { submitted = true; hydrate(await AgentSchedulesApi.run(agentId)); return; }
      if (!/^\d{2}:\d{2}$/.test(time) || !form.days.length || !form.prompt.trim()) throw new Error(t('agentSchedule.invalid'));
      const [hour, minute] = time.split(':').map(Number);
      const slackChannelId = deliveryEnabled ? parseSlackChannel(channel) : null;
      if (deliveryEnabled && (!form.slackBotId || !slackChannelId)) throw new Error(t('agentSchedule.invalidSlack'));
      submitted = true;
      const schedule = await AgentSchedulesApi.save(agentId, {
        enabled: form.enabled, days: form.days, hour, minute, timezone: form.timezone, prompt: form.prompt,
        revision: saved?.revision ?? 0, slackBotId: deliveryEnabled ? form.slackBotId : null, slackChannelId,
      });
      hydrate(schedule);
    } catch (reason) {
      setError(getUserFacingErrorMessage(reason, t('agentSchedule.failed')));
      // A model timeout can still leave a saved draft: refresh the ledger, never repeat the request.
      const current = submitted ? await AgentSchedulesApi.read(agentId).catch(() => null) : null;
      if (current) hydrate(current);
    } finally { setBusy(false); }
  };
  const unchanged = saved && form.enabled === saved.enabled && form.timezone === saved.timezone && form.prompt === saved.prompt
    && time === `${String(saved.hour).padStart(2, '0')}:${String(saved.minute).padStart(2, '0')}`
    && JSON.stringify([...form.days].sort()) === JSON.stringify([...saved.days].sort())
    && (deliveryEnabled ? form.slackBotId === saved.slackBotId && parseSlackChannel(channel) === saved.slackChannelId : !saved.slackBotId && !saved.slackChannelId);
  const dateTime = (value: number) => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: saved?.timezone ?? 'Europe/Rome',
  }).format(value);

  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <Dialog.Content maxWidth="560px" style={{ maxHeight: '90dvh', overflowY: 'auto' }}>
      <Dialog.Title>{t('agentSchedule.title')}</Dialog.Title>
      <Dialog.Description size="2">{t(saved?.projectId ? 'agentSchedule.projectDescription' : 'agentSchedule.description')}</Dialog.Description>
      <Flex direction="column" gap="4" mt="4">
        {error && <Text color="red" role="alert">{error}</Text>}
        {loading ? <Text role="status">{t('agentSchedule.loading')}</Text> : !loadFailed && <>
          <Flex asChild gap="2" align="center"><label style={{ minHeight: 44 }}><Switch checked={form.enabled} disabled={busy} onCheckedChange={enabled => setForm({ ...form, enabled })} />{t('agentSchedule.enabled')}</label></Flex>
          <Box><Text as="p" size="2" mb="2">{t('agentSchedule.days')}</Text>
            <Flex gap="3" wrap="wrap">{[1, 2, 3, 4, 5, 6, 0].map(day => <Flex asChild key={day} gap="1" align="center"><label style={{ minHeight: 44 }}>
              <Checkbox disabled={busy} checked={form.days.includes(day)} onCheckedChange={checked => setForm({ ...form, days: checked ? [...form.days, day].sort() : form.days.filter(value => value !== day) })} />
              <Text size="2">{new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)))}</Text>
            </label></Flex>)}</Flex>
          </Box>
          <Flex gap="3" wrap="wrap">
            <Text as="label" size="2" style={{ flex: '1 1 130px' }}>{t('agentSchedule.time')}<TextField.Root size="3" style={{ minHeight: 44 }} type="time" value={time} disabled={busy} onChange={event => setTime(event.target.value)} /></Text>
            <Text as="label" size="2" style={{ flex: '2 1 200px' }}>{t('agentSchedule.timezone')}<TextField.Root size="3" style={{ minHeight: 44 }} value={form.timezone} disabled={busy} onChange={event => setForm({ ...form, timezone: event.target.value })} /></Text>
          </Flex>
          <Text as="label" size="2">{t('agentSchedule.prompt')}<TextArea size="3" rows={4} value={form.prompt} disabled={busy} onChange={event => setForm({ ...form, prompt: event.target.value })} /></Text>
          {saved?.nextRunAt && <Text size="2">{t('agentSchedule.next')}: {dateTime(saved.nextRunAt)}</Text>}
          {!saved?.projectId && <><Heading size="3">{t('agentSchedule.slackTitle')}</Heading>
          {deliveryError && <Text color="red" size="2" role="alert">{t('agentSchedule.slackLoadFailed')}</Text>}
          <Flex asChild gap="2" align="center"><label style={{ minHeight: 44 }}>
            <Switch checked={deliveryEnabled} disabled={busy || (!delivery?.canManage && !deliveryEnabled)} onCheckedChange={enabled => {
              setDeliveryEnabled(enabled);
              if (enabled && !form.slackBotId && delivery?.bots.length === 1) setForm({ ...form, slackBotId: delivery.bots[0].id });
            }} />{t('agentSchedule.sendSlack')}
          </label></Flex>
          {deliveryEnabled && <>
            <Text as="label" size="2">{t('agentSchedule.slackBot')}
              <Select.Root value={form.slackBotId ?? ''} disabled={busy || !delivery?.canManage} onValueChange={slackBotId => setForm({ ...form, slackBotId })}>
                <Select.Trigger aria-label={t('agentSchedule.slackBot')} placeholder={t('agentSchedule.chooseBot')} style={{ width: '100%', minHeight: 44 }} />
                <Select.Content>{delivery?.bots.map(bot => <Select.Item key={bot.id} value={bot.id}>{bot.name}</Select.Item>)}</Select.Content>
              </Select.Root>
            </Text>
            <Text as="label" size="2">{t('agentSchedule.slackChannel')}<TextField.Root size="3" style={{ minHeight: 44 }} value={channel} disabled={busy || !delivery?.canManage} placeholder={t('agentSchedule.channelPlaceholder')} onChange={event => setChannel(event.target.value)} /></Text>
            <Text size="2" color="gray">{t('agentSchedule.channelHelp')}</Text>
          </>}
          {delivery && !delivery.canManage && <Text size="2" color="gray">{t('agentSchedule.slackAdminOnly')}</Text>}
          {delivery?.canManage && <Text size="2"><a href="/workspace/bots/">{t('agentSchedule.manageBots')}</a>{delivery.bots.length === 0 && <> · {t('agentSchedule.noBots')}</>}</Text>}</>}
          <Heading size="3">{t('agentSchedule.runs')}</Heading>
          {!saved?.runs?.length ? <Text size="2" color="gray">{t('agentSchedule.empty')}</Text> : saved.runs.slice(0, 5).map(run => <Flex key={run.id} justify="between" gap="2" wrap="wrap" align="center">
            <Text size="2">{dateTime(run.startedAt)} · {t(`agentSchedule.status.${run.status}`)}</Text>
            {run.conversationId && <Button style={{ minHeight: 44 }} asChild variant="soft"><a href={`/chat/?agentId=${encodeURIComponent(agentId)}&conversationId=${encodeURIComponent(run.conversationId)}`}>{t('agentSchedule.open')}</a></Button>}
          </Flex>)}
        </>}
        <Flex gap="2" justify="end" wrap="wrap">
          <Dialog.Close><Button style={{ minHeight: 44 }} variant="soft" disabled={busy}>{t('agentSchedule.close')}</Button></Dialog.Close>
          <Button style={{ minHeight: 44 }} variant="soft" title={unchanged ? undefined : t('agentSchedule.saveBeforeRun')} disabled={busy || loading || loadFailed || !unchanged || !saved || saved.runs.some(run => run.status === 'running')} onClick={() => void act(true)}>{t(busy ? 'agentSchedule.working' : 'agentSchedule.run')}</Button>
          <Button style={{ minHeight: 44 }} disabled={busy || loading || loadFailed} onClick={() => void act(false)}>{t('agentSchedule.save')}</Button>
        </Flex>
      </Flex>
    </Dialog.Content>
  </Dialog.Root>;
}
