import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { AgentPictureDialog } from '../agent-picture-dialog';
import { AgentPicturesApi } from '../picture-api';

vi.mock('../picture-api', () => ({ AgentPicturesApi: { upload: vi.fn(), remove: vi.fn() } }));
vi.mock('../../chat/hooks/use-agent-detail', () => ({ useAgentDetail: () => ({ detail: { agent: { name: 'Elio', avatarUrl: '/assets/agents/elio-v1.png' } }, unavailable: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:preview'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('agent picture changes', () => {
  it('previews without uploading until Save, and preserves the selected picture on a failed save', async () => {
    const close = vi.fn();
    vi.mocked(AgentPicturesApi.upload).mockRejectedValue(new Error('Upload unavailable'));
    render(<Theme><AgentPictureDialog agentId="elio" open onOpenChange={close} /></Theme>);
    const file = new File(['png'], 'face.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('agentPicture.choose'), { target: { files: [file] } });
    expect((await screen.findByAltText('agentPicture.preview')).getAttribute('src')).toBe('blob:preview');
    expect(AgentPicturesApi.upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    await screen.findByRole('alert');
    expect(close).not.toHaveBeenCalled(); expect(screen.getByText('face.png')).toBeTruthy();
    vi.mocked(AgentPicturesApi.upload).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(AgentPicturesApi.upload).toHaveBeenLastCalledWith('elio', file);
  });
  it('rejects SVG locally and only removes the current image after explicit Save', async () => {
    vi.mocked(AgentPicturesApi.remove).mockResolvedValue(undefined);
    render(<Theme><AgentPictureDialog agentId="elio" open onOpenChange={() => {}} /></Theme>);
    fireEvent.change(screen.getByLabelText('agentPicture.choose'), { target: { files: [new File(['<svg/>'], 'face.svg', { type: 'image/svg+xml' })] } });
    expect(screen.getByRole('alert').textContent).toBe('agentPicture.invalid');
    expect(AgentPicturesApi.upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'agentPicture.remove' }));
    expect(AgentPicturesApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'agentSchedule.save' }));
    await waitFor(() => expect(AgentPicturesApi.remove).toHaveBeenCalledWith('elio'));
  });
});
