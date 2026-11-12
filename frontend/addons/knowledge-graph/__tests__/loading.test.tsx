import '@/lib/__tests__/test-i18n';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
vi.mock('@/app/components/ui/lottie-loader', () => ({ LottieLoader: () => <span /> }));
import { GraphLoading } from '../loading';
afterEach(cleanup);
it('does not show a working bar before progress is known', () => {
  render(<GraphLoading description="Preparing graph" />);
  expect(screen.queryByRole('progressbar')).toBeNull();
});
