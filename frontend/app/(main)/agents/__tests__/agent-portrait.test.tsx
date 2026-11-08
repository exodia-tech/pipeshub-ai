import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentPortrait, isAgentPortrait } from '../agent-portrait';

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
});
