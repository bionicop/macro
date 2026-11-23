import type { CampaignSendgridAccount } from '@service-storage/campaigns';

export const SENDGRID_LINKS = {
  apiKeys: 'https://app.sendgrid.com/settings/api_keys',
  senderAuth: 'https://app.sendgrid.com/settings/sender_auth',
};

export const domainOf = (email: string) =>
  email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();

export type SendgridCheck =
  | { ok: true; via: 'domain' | 'sender'; domain: string }
  | {
      ok: false;
      reason: 'not-connected' | 'domain-pending' | 'not-authenticated';
      domain: string;
    };

/**
 * Whether SendGrid accepts mail from this address. SendGrid sends only from
 * a domain authenticated in the account (its DNS records verified) or from
 * an address verified on its own as a single sender; anything else it drops.
 */
export function checkSendgridSender(
  account: CampaignSendgridAccount | undefined,
  email: string
): SendgridCheck {
  const domain = domainOf(email);
  if (!account?.connected)
    return { ok: false, reason: 'not-connected', domain };
  const match = account.domains.find(
    (entry) => entry.domain.toLowerCase() === domain
  );
  if (match?.valid) return { ok: true, via: 'domain', domain };
  const address = email.trim().toLowerCase();
  if (
    account.verifiedSenders.some((sender) => sender.toLowerCase() === address)
  )
    return { ok: true, via: 'sender', domain };
  return {
    ok: false,
    reason: match ? 'domain-pending' : 'not-authenticated',
    domain,
  };
}

/** What stops this address sending through SendGrid, in words. */
export function sendgridProblem(check: SendgridCheck): string | undefined {
  if (check.ok) return undefined;
  switch (check.reason) {
    case 'not-connected':
      return 'Connect SendGrid to send from this address.';
    case 'domain-pending':
      return `${check.domain} is added in SendGrid, but its DNS records aren’t verified yet.`;
    case 'not-authenticated':
      return `${check.domain} isn’t authenticated in SendGrid, so it would drop these emails.`;
  }
}
