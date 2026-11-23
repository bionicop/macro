import { describe, expect, it } from 'vitest';
import { checkSendgridSender, domainOf, sendgridProblem } from './sendgrid';

const account = {
  connected: true,
  checkedAt: '2026-11-12T10:00:00Z',
  domains: [
    { domain: 'acme.com', valid: true },
    { domain: 'pending.io', valid: false },
  ],
  verifiedSenders: ['Solo@Gmail.com'],
};

describe('checkSendgridSender', () => {
  it('needs a connected account', () => {
    expect(checkSendgridSender(undefined, 'a@acme.com')).toMatchObject({
      ok: false,
      reason: 'not-connected',
    });
    expect(
      checkSendgridSender({ ...account, connected: false }, 'a@acme.com')
    ).toMatchObject({ ok: false, reason: 'not-connected' });
  });

  it('accepts any address on an authenticated domain, any case', () => {
    expect(checkSendgridSender(account, 'Jane@ACME.com')).toEqual({
      ok: true,
      via: 'domain',
      domain: 'acme.com',
    });
  });

  it('does not treat a subdomain as its parent', () => {
    expect(checkSendgridSender(account, 'a@mail.acme.com')).toMatchObject({
      ok: false,
      reason: 'not-authenticated',
    });
  });

  it('accepts a verified single sender on an unauthenticated domain', () => {
    expect(checkSendgridSender(account, ' solo@gmail.com ')).toMatchObject({
      ok: true,
      via: 'sender',
    });
    expect(checkSendgridSender(account, 'other@gmail.com')).toMatchObject({
      ok: false,
      reason: 'not-authenticated',
    });
  });

  it('flags a domain whose DNS is not verified yet', () => {
    const check = checkSendgridSender(account, 'a@pending.io');
    expect(check).toMatchObject({ ok: false, reason: 'domain-pending' });
    expect(sendgridProblem(check)).toContain('pending.io');
  });
});

describe('domainOf', () => {
  it('takes the part after the last @', () => {
    expect(domainOf('"a@b"@Example.COM ')).toBe('example.com');
  });
});
