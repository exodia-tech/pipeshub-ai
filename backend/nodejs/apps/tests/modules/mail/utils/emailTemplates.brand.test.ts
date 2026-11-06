import { expect } from 'chai';
import { loginWithOTPRequest, appUserInvite } from '../../../../src/modules/mail/utils/emailTemplates';
import { DEFAULT_BRAND, setBrandResolver } from '../../../../src/libs/branding';

const FOOTER =
  'Where your team and AI work together. EXODIA Brain is an open-source context layer for AI agents and an enterprise search platform, with permission-aware, cited answers across your work apps.';

const text = (html: string): string => html.replace(/\s+/g, ' ');

describe('email templates and the brand', () => {
  afterEach(() => setBrandResolver(() => DEFAULT_BRAND));

  it('render EXODIA Brain, its support address and privacy link by default', () => {
    const login = text(loginWithOTPRequest({ name: 'Ada', otp: '123456' }));
    const invite = text(appUserInvite({ invitee: 'Bob', orgName: 'Acme', link: 'https://app.test/x' }));

    expect(login).to.include('Your EXODIA Brain sign-in code');
    expect(login).to.include(FOOTER);
    expect(login).to.include('href="mailto:mo@exodiatech.com"');
    expect(login).to.include('href="https://exodiatech.com/privacy"');
    expect(invite).to.include('on EXODIA Brain');
    expect(invite).to.include('>mo@exodiatech.com</a>');
  });

  it('take the name, addresses and footer from a registered resolver', () => {
    setBrandResolver(() => ({
      ...DEFAULT_BRAND,
      productName: 'Acme Search',
      supportEmail: 'help@example.com',
      privacyUrl: null,
      footerBlurb: 'Acme footer.',
    }));

    const login = text(loginWithOTPRequest({ name: 'Ada', otp: '123456' }));

    expect(login).to.include('Your Acme Search sign-in code');
    expect(login).to.include('Acme footer.');
    expect(login).to.include('href="mailto:help@example.com"');
    expect(login).to.not.include('Privacy Policy');
    expect(login).to.not.include('EXODIA Brain');
  });

  it('uses the EXODIA logo and ignores arbitrary logo URLs', () => {
    setBrandResolver(() => ({ ...DEFAULT_BRAND, emailLogoUrl: 'https://cdn.example.com/logo.png' }) as typeof DEFAULT_BRAND);

    const login = text(loginWithOTPRequest({ name: 'Ada', otp: '123456' }));

    expect(login).to.not.include('https://cdn.example.com/logo.png');
    expect(login).to.include('https://brain.exodia.ws/logo/exodia-brain-logo.png');
    expect(login).to.include('EXODIA Brain');
  });

  it('let a caller-supplied brand field win over the configured brand', () => {
    const login = text(loginWithOTPRequest({ name: 'Ada', otp: '123456', productName: 'Caller Product' }));

    expect(login).to.include('Your Caller Product sign-in code');
  });
});
