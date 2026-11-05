// Modified by EXODIA: shared loader uses the EXODIA Brain mark instead of upstream animations.
'use client';

import React from 'react';
import { Flex, Text } from '@radix-ui/themes';
import { PipesHubIcon } from './pipes-hub-icon';

export type LottieVariant = 'loader' | 'listening' | 'thinking' | 'still';

interface LottieLoaderProps {
  variant?: LottieVariant;
  size?: number;
  loop?: boolean;
  autoplay?: boolean;
  style?: React.CSSProperties;
  showLabel?: boolean;
  label?: string;
}

export function LottieLoader({ variant = 'loader', autoplay = true, loop = true, size = 32, style, showLabel = false, label = 'Loading...' }: LottieLoaderProps) {
  const mark = <PipesHubIcon size={size} color="var(--accent-9)"
    className={autoplay && variant !== 'still' ? 'exodia-brain-active' : undefined}
    style={{ animationIterationCount: loop ? 'infinite' : 1, ...style }} />;
  if (!showLabel) return mark;
  return (
    <Flex direction="column" align="center" gap="2">
      {mark}
      <Text size="2" weight="medium" style={{ color: 'var(--slate-11)' }}>{label}</Text>
    </Flex>
  );
}
