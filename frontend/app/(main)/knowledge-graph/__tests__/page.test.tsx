import '@/lib/__tests__/test-i18n';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

const api = vi.hoisted(() => ({ search: vi.fn(), neighbors: vi.fn() }));
vi.mock('../api', () => ({ GraphApi: api }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Background: () => null,
  Controls: () => null,
}));
import KnowledgeGraphPage from '../page';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('Knowledge graph', () => {
  it('finds accessible entities, opens their records and explores a related entity', async () => {
    const entity = { entityId: 'topic-1', entityType: 'topic', name: 'Invoices' };
    const related = { entityId: 'topic-2', entityType: 'topic', name: 'Contracts' };
    api.search.mockResolvedValue([entity]);
    api.neighbors.mockResolvedValueOnce({ records: [{ recordId: 'r1', recordName: 'Invoice policy', recordType: 'PDF', webUrl: 'https://example.com/policy' }], relatedEntities: [related] });
    api.neighbors.mockResolvedValueOnce({ records: [], relatedEntities: [] });
    render(<Theme><KnowledgeGraphPage /></Theme>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Invoices' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: /Invoices/ }));
    expect(api.neighbors).toHaveBeenCalledWith(entity);
    fireEvent.click(await screen.findByRole('button', { name: 'Invoice policy' }));
    expect(screen.getByRole('link', { name: 'Open source' }).getAttribute('href')).toBe('https://example.com/policy');
    fireEvent.click(screen.getByRole('button', { name: 'Contracts' }));
    await waitFor(() => expect(api.neighbors).toHaveBeenLastCalledWith(related));
    expect(await screen.findByText('No accessible records in this neighborhood.')).toBeTruthy();
  });

  it('shows failures without fabricating empty search results', async () => {
    api.search.mockRejectedValue(new Error('offline'));
    render(<Theme><KnowledgeGraphPage /></Theme>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No matching accessible entities found.')).toBeNull();
  });

  it('does not render unsafe source links', async () => {
    api.search.mockResolvedValue([{ entityId: 'a', entityType: 'topic', name: 'A' }]);
    api.neighbors.mockResolvedValue({ records: [{ recordId: 'r', recordName: 'Record', webUrl: 'javascript:alert(1)' }], relatedEntities: [] });
    render(<Theme><KnowledgeGraphPage /></Theme>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: /^A/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record' }));
    expect(screen.queryByRole('link', { name: 'Open source' })).toBeNull();
  });
});
