'use client';

import React from 'react';
import { Blocks } from 'lucide-react';

interface YourConnectorsIconProps { size?: number; color?: string; style?: React.CSSProperties; }

export const YourConnectorsIcon = ({ size = 16, color = 'currentColor', style }: YourConnectorsIconProps) => (
  <Blocks size={size} color={color} strokeWidth={1.8} aria-hidden="true"
    style={{ display: 'inline-flex', flexShrink: 0, ...style }} />
);
