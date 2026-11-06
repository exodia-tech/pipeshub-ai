'use client';

import React from 'react';
import Image from 'next/image';

export interface BrandWordmarkProps {
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}

/** The product wordmark on the sign-in hero. Editions plug in via config.ts. */
export function BrandWordmark({ width = 240, height = 80, style }: BrandWordmarkProps) {
  return (
    <Image
      src="/login-page-assets/exodia-brain/white-horizontal.svg"
      alt="EXODIA Brain"
      width={width}
      height={height}
      style={{ opacity: 0.95, filter: 'brightness(0) invert(1)', ...style }}
    />
  );
}
