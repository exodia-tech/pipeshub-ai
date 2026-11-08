import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { AgentScheduleDialog } from '../agent-schedule-dialog';
import { AgentSchedulesApi } from '../schedule-api';

vi.mock('../schedule-api', () => ({ AgentSchedulesApi: { read: vi.fn(), save: vi.fn(), run: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }) }));
const translate = (key: string) => key;
const saved = { enabled: true, days: [1, 3, 5], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: 'Public AI brief', revision: 1, nextRunAt: 1794211200000, runs: [] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('native schedule controls', () => {
  it('shows automatic pausing when an uncertain run returns a reconciled ledger', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue(saved);
    vi.mocked(AgentSchedulesApi.run).mockResolvedValue({ ...saved, enabled: false, nextRunAt: null, runs: [{ id: 'run', status: 'needs_reconciliation', startedAt: 1794160000000 }] });
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.run' }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(AgentSchedulesApi.run).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/needs_reconciliation/)).toBeTruthy();
  });
  it('keeps invalid unsaved timezone text from crashing the saved run dates', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue(saved);
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    const field = await screen.findByLabelText('agentSchedule.timezone');
    fireEvent.change(field, { target: { value: 'Europe/' } });
    expect(screen.getByText(/agentSchedule.next/)).toBeTruthy();
  });
});
