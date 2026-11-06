import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BrandProvider, DEFAULT_BRAND, docsHref, githubApiUrl, useBrand } from '@/lib/branding';

function ProductName() {
  return <span data-testid="product">{useBrand().productName}</span>;
}

describe('BrandProvider', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps EXODIA support links usable with a single-file guide', () => {
    expect(docsHref(DEFAULT_BRAND.docsUrl, 'agents/skills')).toBe(DEFAULT_BRAND.docsUrl);
    expect(githubApiUrl(DEFAULT_BRAND.githubUrl)).toBe('https://api.github.com/repos/exodia-tech/pipeshub-ai');
    expect(DEFAULT_BRAND.supportEmail).toBe('mo@exodiatech.com');
  });

  it('uses the default brand and makes no request without loadBrand', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    document.title = 'EXODIA Brain AI';

    render(
      <BrandProvider>
        <ProductName />
      </BrandProvider>,
    );

    expect(screen.getByTestId('product').textContent).toBe('EXODIA Brain');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.title).toBe('EXODIA Brain AI');
  });

  it('gives the default brand outside a provider', () => {
    render(<ProductName />);
    expect(screen.getByTestId('product').textContent).toBe('EXODIA Brain');
  });

  it('uses the brand loadBrand returns, and its name as the page title', async () => {
    const loadBrand = vi.fn().mockResolvedValue({ ...DEFAULT_BRAND, productName: 'Acme Search' });

    render(
      <BrandProvider loadBrand={loadBrand}>
        <ProductName />
      </BrandProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('product').textContent).toBe('Acme Search'));
    expect(loadBrand).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('Acme Search');
  });
});
