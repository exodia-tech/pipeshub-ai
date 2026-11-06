import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MaterialIcon } from '../MaterialIcon';
import { getIndexStatusIcon } from '@/lib/utils/index-status-icon';
import { LUCIDE_ICON_MAP } from '../lucide-icon-map';

afterEach(cleanup);

describe('Lucide interface icons', () => {
  it('renders local SVGs without font ligatures and preserves sizing and events', () => {
    const onClick = vi.fn();
    const { container } = render(<button aria-label="Settings" onClick={onClick}>
      <MaterialIcon name="settings" size={18} color="blue" />
    </button>);
    const icon = container.querySelector('[data-icon="settings"]') as HTMLElement;
    expect(icon.style.width).toBe('18px');
    expect(icon.style.color).toBe('blue');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('svg.lucide')).not.toBeNull();
    expect(icon.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(['unknown-icon', '__proto__', 'constructor'])('safely renders an unknown saved ID: %s', (name) => {
    const { container } = render(<MaterialIcon name={name} aria-label="Unknown icon" role="img" />);
    expect(screen.getByRole('img', { name: 'Unknown icon' })).toBeTruthy();
    expect(container.querySelector('svg.lucide')).not.toBeNull();
  });

  it('covers every indexing state and keeps password and file actions distinct', () => {
    for (const state of ['COMPLETED', 'IN_PROGRESS', 'FAILED', 'NOT_STARTED', 'QUEUED', 'PAUSED', 'FILE_TYPE_NOT_SUPPORTED', 'AUTO_INDEX_OFF', 'EMPTY', 'PASSWORD_PROTECTED']) {
      expect(Object.hasOwn(LUCIDE_ICON_MAP, getIndexStatusIcon(state))).toBe(true);
    }
    expect(LUCIDE_ICON_MAP.visibility).not.toBe(LUCIDE_ICON_MAP.visibility_off);
    expect(LUCIDE_ICON_MAP.upload).not.toBe(LUCIDE_ICON_MAP.download);
  });
});
