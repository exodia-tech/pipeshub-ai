export const DEFAULT_BRAND = {
  productName: 'EXODIA Brain',
  companyName: 'EXODIA',
  tagline: 'Your tools. One shared brain.',
  supportEmail: 'mo@exodiatech.com',
  websiteUrl: 'https://exodiatech.com',
  docsUrl: 'https://github.com/exodia-tech/pipeshub-ai/blob/exodia/coolify-setup/docs/exodia-brain.md',
  privacyUrl: 'https://exodiatech.com/privacy',
  githubUrl: 'https://github.com/exodia-tech/pipeshub-ai',
};

export type PublicBrand = {
  productName: string;
  companyName: string;
  tagline: string;
  supportEmail: string;
  websiteUrl: string | null;
  docsUrl: string | null;
  privacyUrl: string | null;
  githubUrl: string | null;
};

export function docsHref(docsUrl: string | null, path = ''): string | null {
  if (!docsUrl) return null;
  if (docsUrl.endsWith('.md')) return docsUrl;
  const base = docsUrl.endsWith('/') ? docsUrl : `${docsUrl}/`;
  if (!path) return base;
  return `${base}${path.replace(/^\//, '')}`;
}

export function githubApiUrl(githubUrl: string | null): string | null {
  if (!githubUrl) return null;
  const match = githubUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) return null;
  const repo = match[2].replace(/\.git$/i, '');
  return `https://api.github.com/repos/${match[1]}/${repo}`;
}

export function i18nBrandVariables(brand: Pick<PublicBrand, 'productName' | 'companyName'>) {
  return {
    productName: brand.productName,
    companyName: brand.companyName,
    year: String(new Date().getFullYear()),
  };
}
