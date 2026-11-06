import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { SUPPORTED_LANGUAGES } from '../supported-languages';
import { locales } from '../locales';
import italian from '../locales/it-IT.json';

describe('Italian interface', () => {
  it('registers Italian and renders navigation and interpolated greetings', async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: 'it-IT',
      fallbackLng: false,
      resources: { 'it-IT': { translation: italian } },
      interpolation: { escapeValue: false },
    });
    expect(SUPPORTED_LANGUAGES['it-IT'].menuName).toBe('Italiano (Italia)');
    expect(locales['it-IT']).toEqual(italian);
    expect(i18n.t('nav.collections')).toBe('Raccolte');
    expect(i18n.t('collections.trash.restoreSelected', { count: 2 })).toBe('Ripristina 2 elementi');
    expect(i18n.t('collections.trash.restoreFailedTitle', { name: 'Contratto' })).toBe("Impossibile ripristinare 'Contratto'");
    expect(i18n.t('workspaceMenu.language')).toBe('Lingua');
    expect(i18n.t('chat.newChat')).toBe('Nuova chat');
    expect(i18n.t('chat.heyUser', { name: 'Mo' })).toBe('Ciao, Mo 👋');
    expect(i18n.t('shareSidebar.memberCount', { count: 1 })).toBe('1 membro');
    expect(i18n.t('shareSidebar.memberCount', { count: 2 })).toBe('2 membri');
    expect(i18n.t('shareSidebar.memberCount', { count: 1_000_000 })).toBe('1000000 membri');
  });
});
