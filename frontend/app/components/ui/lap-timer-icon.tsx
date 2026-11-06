'use client';

import React from 'react';
import { Timer } from 'lucide-react';

interface LapTimerIconProps { size?: number; color?: string; style?: React.CSSProperties; }

export const LapTimerIcon = ({ size = 16, color = 'currentColor', style }: LapTimerIconProps) => (
  <Timer size={size} color={color} strokeWidth={1.8} aria-hidden="true"
    style={{ display: 'inline-flex', flexShrink: 0, ...style }} />
);
