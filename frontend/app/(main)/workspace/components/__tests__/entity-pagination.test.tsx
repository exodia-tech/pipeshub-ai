import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

import '@/lib/__tests__/test-i18n';

vi.mock('@/app/components/ui/MaterialIcon', () => ({
  MaterialIcon: () => null,
}));

import { EntityPagination } from '../entity-pagination';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(totalCount: number) {
  render(
    <Theme>
      <EntityPagination
        page={1}
        limit={25}
        totalCount={totalCount}
        onPageChange={() => {}}
      />
    </Theme>,
  );
}

describe('EntityPagination', () => {
  it('pages cursor results without inventing a total count', () => {
    const changePage = vi.fn();
    render(
      <Theme>
        <EntityPagination
          page={2}
          limit={25}
          itemCount={7}
          hasNextPage={false}
          onPageChange={changePage}
        />
      </Theme>,
    );
    expect(screen.getByText('Showing 26-32')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(changePage).toHaveBeenCalledWith(1);
    expect(screen.queryByText(/of .*items/)).toBeNull();
  });
  it('uses a keyboard-accessible page-size control and blocks navigation while loading', async () => {
    const changeLimit = vi.fn();
    const { rerender } = render(
      <Theme>
        <EntityPagination
          page={1}
          limit={25}
          itemCount={25}
          hasNextPage
          onPageChange={() => {}}
          onLimitChange={changeLimit}
        />
      </Theme>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: '25 per page' }), {
      key: 'Enter',
    });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: '10 per page' }),
    );
    expect(changeLimit).toHaveBeenCalledWith(10);
    rerender(
      <Theme>
        <EntityPagination
          page={2}
          limit={25}
          itemCount={25}
          hasNextPage
          disabled
          onPageChange={() => {}}
          onLimitChange={changeLimit}
        />
      </Theme>,
    );
    for (const name of ['Previous', 'Next', '25 per page'])
      expect(screen.getByRole('button', { name })).toHaveProperty(
        'disabled',
        true,
      );
  });

  it('counts many items in the plural', () => {
    setup(26);
    expect(screen.getByText('Showing 1-25 of 26 items')).toBeTruthy();
  });

  it('counts one item in the singular', () => {
    setup(1);
    expect(screen.getByText('Showing 1-1 of 1 item')).toBeTruthy();
  });

  it('shows no counter when there are no rows', () => {
    setup(0);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});
