'use client';

import { Flex, Progress, Text } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { LottieLoader } from '@/app/components/ui/lottie-loader';

export function GraphLoading({ description, value }: { description?: string; value?: number }) {
  const { t } = useTranslation();
  return <Flex direction="column" align="center" justify="center" gap="4" role="status" aria-live="polite" aria-busy="true" style={{ flex: 1, minHeight: 320, width: '100%' }}>
    <LottieLoader variant="loader" size={56} />
    <Text size="3" weight="medium">{t('graph.preparing')}</Text>
    <Flex direction="column" gap="2" align="center" style={{ width: 'min(300px, 85%)' }}>
      {typeof value === 'number' && Number.isFinite(value) && <Progress value={value} style={{ width: '100%' }} aria-label={description} />}
      {description && <Text size="2" color="gray" align="center">{description}</Text>}
    </Flex>
  </Flex>;
}
