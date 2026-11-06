'use client';

import React from 'react';
import { Inbox } from 'lucide-react';

interface EmptyIconProps { size?: number; color?: string; style?: React.CSSProperties; }

export const EmptyIcon = ({ size = 56, color = 'currentColor', style }: EmptyIconProps) => (
  <Inbox size={size} color={color} strokeWidth={1.8} aria-hidden="true"
    style={{ display: 'inline-flex', flexShrink: 0, ...style }} />
);
