import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { UserAvatar } from '../user-avatar';

afterEach(cleanup);

describe('profile avatar sizing', () => {
  it.each([24, 36, 48])('keeps the requested %spx size and round shape without a photo', async (size) => {
    const { container } = render(<Theme><UserAvatar fullName="Mario Gallo" size={size} /></Theme>);
    expect(await screen.findByText('MG')).toBeTruthy();
    const avatar = container.querySelector('.rt-AvatarRoot') as HTMLElement;
    expect(avatar.style.width).toBe(`${size}px`);
    expect(avatar.style.height).toBe(`${size}px`);
    expect(avatar.getAttribute('data-radius')).toBe('full');
  });
});
