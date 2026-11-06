'use client';

import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import React from 'react';
import { Flex, Text } from '@radix-ui/themes';

interface InfoBannerProps {
  message: string;
}

export function InfoBanner({ message }: InfoBannerProps) {
  return (
    <Flex
      align="start"
      gap="2"
      style={{
        backgroundColor: 'var(--accent-a2)',
        border: '1px solid var(--accent-a4)',
        borderRadius: 'var(--radius-2)',
        padding: '10px 12px',
        marginBottom: '16px',
      }}
    >
      <MaterialIcon name="info" size={16} style={{
          fontSize: '16px',
          color: 'var(--accent-11)',
          flexShrink: 0,
          marginTop: '1px',
        }} />
      <Text size="1" style={{ color: 'var(--accent-11)', lineHeight: '1.5' }}>
        {message}
      </Text>
    </Flex>
  );
}
