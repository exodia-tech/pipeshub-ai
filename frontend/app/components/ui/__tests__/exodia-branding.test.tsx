import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LottieLoader } from '../lottie-loader';

afterEach(cleanup);

describe('EXODIA Brain loading states', () => {
  it('renders the branded vector and an optional status label without a Lottie player', () => {
    const { container } = render(<LottieLoader size={48} showLabel label="Loading EXODIA Brain" />);
    expect(screen.getByText('Loading EXODIA Brain')).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('48');
    expect(container.querySelector('image')?.getAttribute('href')).toBe('/logo/exodia-brain-mark.png');
    expect(container.querySelector('svg')?.classList.contains('exodia-brain-active')).toBe(true);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it.each([{ variant: 'still' as const }, { autoplay: false }])('keeps disabled or still states static: %j', (props) => {
    const { container } = render(<LottieLoader {...props} />);
    expect(container.querySelector('svg')?.classList.contains('exodia-brain-active')).toBe(false);
  });
});
