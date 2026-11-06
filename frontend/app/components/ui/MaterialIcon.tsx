'use client';

import React from 'react';
import { CircleHelp } from 'lucide-react';
import { LUCIDE_ICON_MAP } from './lucide-icon-map';

interface MaterialIconProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  name: string;
  size?: number;
  color?: string;
  variant?: 'outlined' | 'filled';
}

// The compatibility name avoids rewriting saved icon IDs or every caller.
export const MaterialIcon = ({ name, size = 20, color, style, variant: _variant, ...props }: MaterialIconProps) => {
  const Icon = Object.hasOwn(LUCIDE_ICON_MAP, name) ? LUCIDE_ICON_MAP[name] : CircleHelp;
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby'] || props.title);
  return (
    <span
      aria-hidden={labelled ? undefined : true}
      {...props}
      data-icon={name}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, width: size, height: size, fontSize: size, color: color || 'inherit',
        lineHeight: 1, verticalAlign: 'middle', ...style }}
    >
      <Icon size="1em" strokeWidth={1.8} aria-hidden="true" focusable="false" />
    </span>
  );
};
