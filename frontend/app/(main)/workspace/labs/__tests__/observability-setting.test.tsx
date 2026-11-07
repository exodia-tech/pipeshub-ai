import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';

vi.mock('@/lib/api', () => ({ apiClient: { get: vi.fn(), put: vi.fn() } }));
import { apiClient } from '@/lib/api';
import { ObservabilitySetting } from '../observability-setting';

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('organization observability setting', () => {
  it('loads and saves the organization switch', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { enabled: false } });
    vi.mocked(apiClient.put).mockResolvedValue({ data: { enabled: true } });
    render(<Theme><ObservabilitySetting /></Theme>);
    const toggle = await screen.findByRole('switch', { name: /export usage/i });
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('unchecked'));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));
    expect(apiClient.put).toHaveBeenCalledWith('/api/v1/usage/observability', { enabled: true }, expect.anything());
  });

  it('keeps the saved value when saving fails', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { enabled: false } });
    vi.mocked(apiClient.put).mockRejectedValue(new Error('offline'));
    render(<Theme><ObservabilitySetting /></Theme>);
    const toggle = await screen.findByRole('switch', { name: /export usage/i });
    await waitFor(() => expect(toggle).not.toHaveProperty('disabled', true));
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('allows retry after loading fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { enabled: true } });
    render(<Theme><ObservabilitySetting /></Theme>);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /export usage/i }).getAttribute('data-state')).toBe('checked'));
  });
});
