'use client';

import React from 'react';
import { MessageCirclePlus } from 'lucide-react';

interface ChatStarIconProps { size?: number; color?: string; style?: React.CSSProperties; }

export const ChatStarIcon = ({ size = 16, color = 'currentColor', style }: ChatStarIconProps) => (
  <MessageCirclePlus size={size} color={color} strokeWidth={1.8} aria-hidden="true"
    style={{ display: 'inline-flex', flexShrink: 0, ...style }} />
);
