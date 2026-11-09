'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { getUserFacingErrorMessage } from '@/lib/api/api-error';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useAgentDetail } from '../chat/hooks/use-agent-detail';
import { AgentPortrait } from './agent-portrait';
import { AgentPicturesApi } from './picture-api';

export function AgentPictureDialog({ agentId, open, onOpenChange }: { agentId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { detail, unavailable } = useAgentDetail(agentId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setFile(null); setRemove(false); setError(''); }, [agentId, open]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (file) await AgentPicturesApi.upload(agentId, file);
      else if (remove) await AgentPicturesApi.remove(agentId);
      onOpenChange(false);
    } catch (reason) { setError(getUserFacingErrorMessage(reason, t('agentPicture.failed'))); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <Dialog.Content maxWidth="420px" style={{ maxHeight: '90dvh', overflowY: 'auto' }}>
      <Dialog.Title>{t('agentPicture.title')}</Dialog.Title>
      <Dialog.Description size="2">{t('agentPicture.description')}</Dialog.Description>
      <Flex direction="column" gap="4" mt="4">
        {(error || unavailable) && <Text color="red" role="alert">{error || t('agentPicture.failed')}</Text>}
        <Flex justify="center" align="center" style={{ height: 128 }}>
          {preview ? <img src={preview} alt={t('agentPicture.preview')} width={112} height={112} style={{ borderRadius: '50%', objectFit: 'cover' }} />
            : !remove && detail?.agent?.avatarUrl ? <AgentPortrait src={detail.agent.avatarUrl} name={detail.agent.name} size={112} />
              : <MaterialIcon name="person" size={64} color="var(--gray-10)" />}
        </Flex>
        <input ref={input} aria-label={t('agentPicture.choose')} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => {
          const chosen = event.target.files?.[0]; event.target.value = '';
          if (!chosen) return;
          if (chosen.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type)) { setError(t('agentPicture.invalid')); return; }
          setError(''); setFile(chosen); setRemove(false);
        }} />
        <Flex gap="2" wrap="wrap" justify="center">
          <Button variant="soft" style={{ minHeight: 44 }} disabled={busy || !detail?.agent || unavailable} onClick={() => input.current?.click()}>{t('agentPicture.choose')}</Button>
          <Button variant="ghost" color="gray" style={{ minHeight: 44 }} disabled={busy || !detail?.agent || unavailable || (!file && !detail.agent.avatarUrl) || remove} onClick={() => { setFile(null); setRemove(true); setError(''); }}>{t('agentPicture.remove')}</Button>
        </Flex>
        {file && <Text size="2" style={{ overflowWrap: 'anywhere' }}>{file.name}</Text>}
        <Text size="2" color="gray">{t('agentPicture.formats')}</Text>
        <Flex gap="2" justify="end" wrap="wrap">
          <Dialog.Close><Button variant="soft" style={{ minHeight: 44 }} disabled={busy}>{t('agentSchedule.close')}</Button></Dialog.Close>
          <Button style={{ minHeight: 44 }} disabled={busy || (!file && !remove) || !detail?.agent || unavailable} onClick={() => void save()}>{t(busy ? 'agentPicture.saving' : 'agentSchedule.save')}</Button>
        </Flex>
      </Flex>
    </Dialog.Content>
  </Dialog.Root>;
}
