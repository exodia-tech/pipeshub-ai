import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentPortrait, isAgentPortrait } from '../agent-portrait';
const cached = vi.hoisted(() => ({ data: undefined as string | undefined, error: undefined as unknown }));
vi.mock('swr', () => ({ default: () => cached, mutate: vi.fn() }));

describe('agent portraits', () => {
  it('accepts owned assets and refuses remote, data and traversing URLs', () => {
    expect(isAgentPortrait('/assets/agents/elio-v1.png')).toBe(true);
    for (const src of ['https://example.com/photo.png', '//example.com/a.png', 'data:image/png;base64,eA==', '/assets/agents/../../secret.png', '/assets/agents/a.svg', '/assets/agents/a.png?token=secret']) {
      expect(isAgentPortrait(src)).toBe(false);
    }
  });
  it('uses explicit small and large dimensions without exposing external assets', () => {
    const { rerender } = render(<AgentPortrait src="/assets/agents/elio-v1.png" name="Elio" size={28} />);
    expect(screen.getByAltText('Elio').getAttribute('width')).toBe('28');
    rerender(<AgentPortrait src="/assets/agents/elio-v1.png" name="Elio" size={112} />);
    expect(screen.getByAltText('Elio').getAttribute('width')).toBe('112');
    rerender(<AgentPortrait src="https://example.com/photo.png" name="Elio" />);
    expect(screen.queryByAltText('Elio')).toBeNull();
  });
  it('hides cached private bytes when the agent is no longer visible or the picture was removed', () => {
    const src = '/api/v1/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/avatar/120d1a70-989a-499b-8e41-170b2a07a820';
    cached.data = 'data:image/webp;base64,cached';
    const { rerender, unmount } = render(<AgentPortrait src={src} name="Private face" />);
    expect(screen.getByAltText('Private face').getAttribute('src')).toBe(cached.data);
    for (const statusCode of [403, 404]) {
      cached.error = { type: 'SERVER_ERROR', statusCode, message: 'gone' };
      rerender(<AgentPortrait src={src} name="Private face" />);
      expect(screen.queryByAltText('Private face')).toBeNull();
    }
    unmount(); cached.data = undefined; cached.error = undefined;
  });
});
