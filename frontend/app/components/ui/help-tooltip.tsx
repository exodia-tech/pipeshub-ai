'use client';

import React from 'react';
import { Tooltip } from '@radix-ui/themes';
import { buildHelpTooltipProps } from './help-tooltip-props';

export type HelpTooltipProps = {
  /** Plain text only — Radix tooltips set their own text/background colors. */
  content: string;
  maxWidth?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

export function HelpTooltip({
  content,
  maxWidth,
  open,
  onOpenChange,
  children,
}: HelpTooltipProps) {
  const tooltipProps = buildHelpTooltipProps(content, maxWidth);

  return (
    <Tooltip {...tooltipProps} open={open} onOpenChange={onOpenChange}>
      {children}
    </Tooltip>
  );
}
