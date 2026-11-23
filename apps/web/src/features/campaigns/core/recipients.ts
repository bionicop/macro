// What we know about one person in a campaign, shared by the People tab and
// the per-email report so both read progress and fill copy the same way.

import type { CampaignRecipient } from '@service-storage/campaigns';
import { normalizeField, TAG } from './email-checks';

/** Emails this person has been sent, out of the sequence's length. */
export const sentCount = (recipient: CampaignRecipient, total: number) =>
  recipient.state === 'completed'
    ? total
    : Math.max(0, Math.min(total, recipient.nextPosition - 1));

/** The part of an address after the @, which usually names the company. */
export const domainOf = (email: string) => email.split('@')[1] ?? '';

/** The merge fields one recipient's copy was filled from. */
export const valuesFor = (recipient: CampaignRecipient) => ({
  'first name': recipient.name?.split(/\s+/)[0] ?? '',
  name: recipient.name ?? '',
  email: recipient.email,
});

/** Fills the fields known for this person; unknown ones stay as written. */
export const fill = (text: string, values?: Record<string, string>) =>
  values
    ? text.replace(
        TAG,
        (tag, name: string, fallback?: string) =>
          values[normalizeField(name)] || fallback?.trim() || tag
      )
    : text;

/** Where one email of the sequence stands for one person. */
export type StepMark = 'sent' | 'next' | 'later' | 'skipped';

/**
 * Each email's mark for this person: sent, the one coming next, still to
 * come, or never going because the sequence stopped for them.
 */
export function stepMarks(
  recipient: CampaignRecipient,
  total: number
): StepMark[] {
  const sent = sentCount(recipient, total);
  const going = recipient.state === 'active';
  return Array.from({ length: total }, (_, at) =>
    at < sent ? 'sent' : !going ? 'skipped' : at === sent ? 'next' : 'later'
  );
}
