import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import '@/lib/__tests__/test-i18n';
import { SearchableCheckboxDropdown } from '../searchable-checkbox-dropdown';
import { WorkspaceRightPanel } from '../workspace-right-panel';

vi.mock('@/app/components/ui/MaterialIcon', () => ({
  MaterialIcon: () => null,
}));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe('shared people picker keyboard controls', () => {
  it('selects with the keyboard and dismisses only the picker on Escape', async () => {
    const closeDrawer = vi.fn();
    function Form() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <Theme>
          <WorkspaceRightPanel
            open
            onOpenChange={closeDrawer}
            title="Access group"
            hideFooter
          >
            <SearchableCheckboxDropdown
              placeholder="Add members"
              options={[
                { id: 'ada', label: 'Ada' },
                { id: 'ben', label: 'Ben' },
              ]}
              selectedIds={selected}
              onSelectionChange={setSelected}
            />
          </WorkspaceRightPanel>
        </Theme>
      );
    }
    render(<Form />);
    const trigger = screen.getByRole('combobox', { name: 'Add members' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const search = screen.getByRole('textbox', { name: 'Add members' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const ada = screen.getByRole('option', { name: 'Ada' });
    expect(document.activeElement).toBe(ada);
    fireEvent.keyDown(ada, { key: ' ' });
    expect(
      screen.getByRole('option', { name: 'Ada' }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(
      screen.getByRole('option', { name: 'Ada' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('does not open a disabled picker with the keyboard', () => {
    render(
      <Theme>
        <SearchableCheckboxDropdown
          disabled
          placeholder="Add members"
          options={[]}
          selectedIds={[]}
          onSelectionChange={() => {}}
        />
      </Theme>,
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Add members' }), {
      key: 'Enter',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
