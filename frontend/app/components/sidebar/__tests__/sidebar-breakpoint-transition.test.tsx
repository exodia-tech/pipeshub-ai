import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SidebarBase } from '../sidebar-base';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, interpolation: { escapeValue: false } });
});
afterEach(cleanup);
vi.mock('@/app/components/ui/MaterialIcon', () => ({ MaterialIcon: () => null }));

function sidebar(isMobile: boolean, mobileOpen = false) {
  return <I18nextProvider i18n={i18n}><Theme>
    <SidebarBase header={<span>Header</span>} isMobile={isMobile} mobileOpen={mobileOpen}>
      <span>Navigation</span>
    </SidebarBase>
  </Theme></I18nextProvider>;
}

describe('sidebar breakpoint transitions', () => {
  it('can change from desktop to a closed mobile drawer without skipping hooks', () => {
    const { rerender } = render(sidebar(false));
    expect(screen.getByText('Navigation')).toBeTruthy();
    expect(() => rerender(sidebar(true))).not.toThrow();
    expect(screen.queryByText('Navigation')).toBeNull();
  });

  it('can change from mobile back to desktop and open its drawer', () => {
    const { rerender } = render(sidebar(true));
    expect(() => rerender(sidebar(false))).not.toThrow();
    expect(screen.getByText('Navigation')).toBeTruthy();
    expect(() => rerender(sidebar(true, true))).not.toThrow();
    expect(screen.getByText('Navigation')).toBeTruthy();
  });
});
