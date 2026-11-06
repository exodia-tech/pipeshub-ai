'use client';

import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import React from 'react';
import { Flex, Text } from '@radix-ui/themes';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ErrorBannerProps {
  message: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * ErrorBanner — a red-tinted inline error box.
 *
 * Used for generic server errors, expired-link messages, etc.
 */
export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <Flex
      align="start"
      gap="2"
      style={{
        padding: '10px 12px',
        backgroundColor: 'var(--red-a3)',
        border: '1px solid var(--red-a6)',
        borderRadius: 'var(--radius-3)',
      }}
    >
      <MaterialIcon name="error_outline" size={16} style={{
          fontSize: '16px',
          color: 'var(--red-11)',
          marginTop: '1px',
          flexShrink: 0,
        }} />
      <Text size="2" style={{ color: 'var(--red-11)' }}>
        {message}
      </Text>
    </Flex>
  );
}
