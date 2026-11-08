'use client';

import { useEffect, useState } from 'react';
import { Box, Button, Flex, Switch, Text } from '@radix-ui/themes';
import { apiClient } from '@/lib/api';
import { SettingsSection } from '../components/settings-section';

export function ObservabilitySetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError('');
    apiClient.get<{ enabled: boolean }>('/api/v1/usage/observability', { suppressErrorToast: true })
      .then(({ data }) => { if (active) setEnabled(data.enabled); })
      .catch(() => { if (active) setError('Could not load this setting.'); });
    return () => { active = false; };
  }, [attempt]);

  async function update(value: boolean) {
    setSaving(true);
    setError('');
    try {
      const { data } = await apiClient.put<{ enabled: boolean }>('/api/v1/usage/observability', { enabled: value }, { suppressErrorToast: true });
      setEnabled(data.enabled);
    } catch {
      setError('Could not save this setting. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title="Observability">
      <Flex align="center" justify="between" gap="4" style={{ width: '100%' }}>
        <Box style={{ minWidth: 0 }}>
          <Text size="2" weight="medium" style={{ display: 'block' }}>Export usage to an observability provider</Text>
          <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>
            For this organization. Sends model usage and cost metadata when a provider is configured by your administrator. Prompts and responses are not sent.
          </Text>
          {error && <Text size="1" color="red" role="alert" style={{ display: 'block', marginTop: 4 }}>{error}</Text>}
          {error && enabled === null && <Button size="1" variant="soft" onClick={() => setAttempt((value) => value + 1)} style={{ marginTop: 8 }}>Try again</Button>}
        </Box>
        <Switch aria-label="Export usage to an observability provider" checked={enabled === true} disabled={enabled === null || saving} onCheckedChange={update} style={{ flexShrink: 0 }} />
      </Flex>
    </SettingsSection>
  );
}
