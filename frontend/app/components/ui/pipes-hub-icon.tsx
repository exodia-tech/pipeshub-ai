// Modified by EXODIA: official EXODIA website logo replaces upstream artwork.
'use client';

import React from 'react';

interface PipesHubIconProps {
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function PipesHubIcon({ size = 80, color = 'currentColor', style, className }: PipesHubIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-hidden="true"
      style={{ color, display: 'inline-flex', flexShrink: 0, ...style }} className={className}>
      <image href="/logo/exodia-official.jpeg" width="80" height="80" style={{ clipPath: 'circle(50%)' }} />
    </svg>
  );
}
