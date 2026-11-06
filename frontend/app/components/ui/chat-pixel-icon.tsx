'use client';

import React from 'react';
import { MessageCircle } from 'lucide-react';

interface ChatPixelIconProps extends React.SVGProps<SVGSVGElement> { size?: number; }

export function ChatPixelIcon({ size = 100, ...props }: ChatPixelIconProps) {
  return <MessageCircle size={size} strokeWidth={1.8} aria-hidden="true" {...props} />;
}
