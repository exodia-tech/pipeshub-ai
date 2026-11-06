import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LottieLoader } from '../lottie-loader';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EXODIA Brain loading states', () => {
  it('uses the product mark without fetching vendor animations', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<LottieLoader variant="thinking" size={48} showLabel label="Loading" />);
    expect(container.querySelector('image')?.getAttribute('href')).toBe('/logo/exodia-brain-mark.png');
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('48');
    expect(container.querySelector('.exodia-brain-active')).not.toBeNull();
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps still and paused states static and supports a single animation', () => {
    const { container, rerender } = render(<LottieLoader variant="still" />);
    expect(container.querySelector('.exodia-brain-active')).toBeNull();
    rerender(<LottieLoader autoplay={false} />);
    expect(container.querySelector('.exodia-brain-active')).toBeNull();
    rerender(<LottieLoader loop={false} />);
    expect(container.querySelector('svg')?.style.animationIterationCount).toBe('1');
  });
});
