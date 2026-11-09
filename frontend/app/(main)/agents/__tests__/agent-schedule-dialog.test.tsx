import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { AgentScheduleDialog } from '../agent-schedule-dialog';
import { AgentSchedulesApi } from '../schedule-api';

vi.mock('../schedule-api', () => ({ AgentSchedulesApi: { read: vi.fn(), save: vi.fn(), run: vi.fn(), deliveryOptions: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }) }));
const translate = (key: string) => key;
const saved = { enabled: true, days: [1, 3, 5], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: 'Public AI brief', revision: 1, nextRunAt: 1794211200000, runs: [] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { vi.mocked(AgentSchedulesApi.deliveryOptions).mockResolvedValue({ canManage: true, bots: [{ id: 'bot', name: 'Elio' }] }); });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

describe('native schedule controls', () => {
  it('shows automatic pausing when an uncertain run returns a reconciled ledger', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue(saved);
    vi.mocked(AgentSchedulesApi.run).mockResolvedValue({ ...saved, enabled: false, nextRunAt: null, runs: [{ id: 'run', status: 'needs_reconciliation', startedAt: 1794160000000 }] });
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    const toggle = await screen.findByRole('switch', { name: 'agentSchedule.enabled' });
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
  it('normalizes channel links, saves delivery, and prevents running stale settings', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue(saved);
    vi.mocked(AgentSchedulesApi.save).mockImplementation(async (_id, settings) => ({ ...saved, ...settings, revision: 2 }));
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    fireEvent.click(await screen.findByRole('switch', { name: 'agentSchedule.sendSlack' }));
    const channel = screen.getByLabelText('agentSchedule.slackChannel');
    fireEvent.change(channel, { target: { value: 'https://exodiacore.slack.com/archives/C0C6WPPH5V0' } });
    expect(screen.getByRole('button', { name: 'agentSchedule.run' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    await waitFor(() => expect(AgentSchedulesApi.save).toHaveBeenCalledWith('elio', expect.objectContaining({ slackBotId: 'bot', slackChannelId: 'C0C6WPPH5V0', hour: 9, timezone: 'Europe/Rome' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'agentSchedule.run' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('switch', { name: 'agentSchedule.sendSlack' }));
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    await waitFor(() => expect(AgentSchedulesApi.save).toHaveBeenLastCalledWith('elio', expect.objectContaining({ slackBotId: null, slackChannelId: null, hour: 9, days: [1, 3, 5] })));
  });
  it('retains invalid channel input without submitting or discarding the form', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue(saved);
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    fireEvent.click(await screen.findByRole('switch', { name: 'agentSchedule.sendSlack' }));
    fireEvent.change(screen.getByLabelText('agentSchedule.slackChannel'), { target: { value: 'https://evil.example/C0C6WPPH5V0' } });
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('agentSchedule.invalidSlack');
    expect(AgentSchedulesApi.save).not.toHaveBeenCalled();
    expect((screen.getByLabelText('agentSchedule.slackChannel') as HTMLInputElement).value).toBe('https://evil.example/C0C6WPPH5V0');
  });
  it('labels an approved project draft and hides Slack delivery controls', async () => {
    vi.mocked(AgentSchedulesApi.read).mockResolvedValue({ ...saved, projectId: 'project-a' });
    render(<Theme><AgentScheduleDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    expect(await screen.findByText('agentSchedule.projectDescription')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'agentSchedule.sendSlack' })).toBeNull();
  });
});
