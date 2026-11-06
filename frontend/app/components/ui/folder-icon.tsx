'use client';

import React from 'react';
import { Folder, FolderOpen, FolderHeart } from 'lucide-react';

export type FolderIconVariant = 'default' | 'open' | 'special';
interface FolderIconProps {
  variant?: FolderIconVariant; size?: number; color?: string;
  style?: React.CSSProperties; className?: string;
}

export function FolderIcon({ variant = 'default', size = 16, color = 'var(--slate-11)', style, className }: FolderIconProps) {
  const Icon = variant === 'open' ? FolderOpen : variant === 'special' ? FolderHeart : Folder;
  return <Icon size={size} color={color} strokeWidth={1.8} aria-hidden="true" className={className}
    style={{ display: 'inline-flex', flexShrink: 0, ...style }} />;
}
