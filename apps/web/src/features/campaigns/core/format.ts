import type {
  CampaignEventKind,
  CampaignRecipientState,
} from '@service-storage/campaigns';
import type { CampaignStatus, LeadStatus } from './sample';

/** Where each enrolled person is, in the order a sequence moves them. */
export const RECIPIENT_STATE: Record<
  CampaignRecipientState,
  { label: string; fill: string }
> = {
  active: { label: 'In sequence', fill: 'var(--color-accent)' },
  replied: { label: 'Replied', fill: 'var(--color-success)' },
  completed: { label: 'Finished', fill: 'var(--color-purple)' },
  bounced: { label: 'Bounced', fill: 'var(--color-failure)' },
  unsubscribed: { label: 'Asked to stop', fill: 'var(--color-warning)' },
  failed: { label: 'Send failed', fill: 'var(--color-ink-extra-muted)' },
  removed: { label: 'Removed', fill: 'var(--color-edge)' },
};

export const EVENT_KIND: Record<
  CampaignEventKind,
  { verb: string; fill: string }
> = {
  sent: { verb: 'got', fill: 'var(--color-ink-extra-muted)' },
  opened: { verb: 'opened', fill: 'var(--color-purple)' },
  replied: { verb: 'replied to', fill: 'var(--color-success)' },
  bounced: { verb: 'bounced on', fill: 'var(--color-failure)' },
  unsubscribed: { verb: 'asked to stop after', fill: 'var(--color-warning)' },
};

const relative = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
});

/** "now", "5 min ago", "3 hr ago", "yesterday", "4 days ago". */
export function formatRelative(iso: string, now = Date.now()) {
  const seconds = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 60) return 'now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86_400), 'day');
}

/** Lead statuses, worded like the outreach tools people already know. */
export const LEAD_STATUS: Record<LeadStatus, { label: string; fill: string }> =
  {
    not_contacted: { label: 'Not yet contacted', fill: 'var(--color-edge)' },
    contacted: {
      label: 'Contacted',
      fill: 'color-mix(in srgb, var(--color-purple) 45%, transparent)',
    },
    replied: { label: 'Replied', fill: 'var(--color-blue)' },
    interested: { label: 'Interested', fill: 'var(--color-success)' },
    meeting_booked: {
      label: 'Meeting booked',
      fill: 'color-mix(in srgb, var(--color-success) 60%, var(--color-ink))',
    },
    out_of_office: { label: 'Out of office', fill: 'var(--color-warning)' },
    not_interested: {
      label: 'Not interested',
      fill: 'color-mix(in srgb, var(--color-ink) 35%, transparent)',
    },
    bounced: { label: 'Bounced', fill: 'var(--color-failure)' },
    unsubscribed: {
      label: 'Unsubscribed',
      fill: 'color-mix(in srgb, var(--color-failure) 40%, transparent)',
    },
    completed: { label: 'Completed', fill: 'var(--color-purple)' },
  };

/** "today", "yesterday", "5 days ago", or a dash when nothing happened. */
export const formatDaysAgo = (days: number) =>
  days < 0
    ? '—'
    : days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : `${days} days ago`;

const count = new Intl.NumberFormat(undefined);
const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

export const formatCount = (value: number) => count.format(value);

/** A share of sends, or a dash when nothing has been sent yet. */
export const formatShare = (part: number, whole: number) =>
  whole > 0 ? percent.format(part / whole) : '—';

export const STATUS: Record<
  CampaignStatus,
  {
    label: string;
    fill: string;
    /** Text colour for the status label in rows. */
    tone: string;
    /** Shown in place of the 14-day bars when nothing has sent. */
    idle?: string;
  }
> = {
  active: {
    label: 'Sending',
    fill: 'var(--color-success)',
    tone: 'text-success',
  },
  paused: {
    label: 'Paused',
    fill: 'var(--color-ink-extra-muted)',
    tone: 'text-ink-muted',
  },
  draft: {
    label: 'Draft',
    fill: 'var(--color-edge)',
    tone: 'text-ink-extra-muted',
    idle: 'Not started',
  },
  completed: {
    label: 'Completed',
    fill: 'var(--color-accent)',
    tone: 'text-accent',
    idle: 'Finished',
  },
};

/** A step's name in the sequence: the intro, numbered follow-ups, the breakup. */
export const stepTitle = (index: number, total: number) =>
  index === 0
    ? 'Intro'
    : index === total - 1 && total > 2
      ? 'Breakup'
      : `Follow-up ${index}`;
