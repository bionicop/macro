// LOCAL MOCK (not for commit). In-memory campaigns API for the dev gateway,
// shaped like crates/campaign (DSS mounts it at /campaigns; the gateway prefixes
// DSS routes with /dss). State is built from the sample campaigns and mutated by
// launch / pause / settings / steps / rename / trash so the UI round-trips.
import type {
  AccessibleCampaign,
  CampaignStatus as ApiStatus,
  CampaignDailyStats,
  CampaignEvent,
  CampaignRecipient,
  CampaignRecipientState,
  CampaignReplyDraft,
  CampaignSender,
  CampaignSendgridAccount,
  CampaignSendingIdentity,
  CampaignSettings,
  CampaignStats,
  CampaignStep,
  CampaignStepInput,
} from '@service-storage/campaigns';
import {
  type Campaign,
  type CampaignStatus,
  campaignDetails,
  type LeadStatus,
  SAMPLE_CAMPAIGNS,
  sampleLeads,
} from '../features/campaigns/core/sample';
import {
  checkSendgridSender,
  sendgridProblem,
} from '../features/campaigns/core/sendgrid';
import { route } from './index';
import { team, user } from './soup';

const BASE = '/dss/campaigns';
const DAY = 1440;
const PAGE = 25;

// The samples already use the API's status names.
const STATUS: Record<CampaignStatus, ApiStatus> = {
  active: 'active',
  paused: 'paused',
  draft: 'draft',
  completed: 'completed',
};

const RECIPIENT: Record<LeadStatus, CampaignRecipientState> = {
  not_contacted: 'active',
  contacted: 'active',
  replied: 'replied',
  interested: 'replied',
  meeting_booked: 'replied',
  out_of_office: 'active',
  not_interested: 'replied',
  bounced: 'bounced',
  unsubscribed: 'unsubscribed',
  completed: 'completed',
};

type Entry = {
  campaign: AccessibleCampaign;
  events: CampaignEvent[];
  drafts: CampaignReplyDraft[];
  steps: CampaignStep[];
  senders: CampaignSender[];
  recipients: CampaignRecipient[];
  stats: CampaignStats;
  /** Enrolled people the stats stand for (the sample has more than it lists). */
  enrollable: number;
  /** Rows of the people table; filled from the recipients on first read. */
  rows?: { rowId: string }[];
};
const rowsOf = (e: Entry) => {
  e.rows ??= e.recipients.map((r) => ({ rowId: r.rowId }));
  return e.rows;
};

const entries = new Map<string, Entry>();
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const noContent = () => new Response(null, { status: 204 });
const notFound = () => new Response(null, { status: 404 });

function parseWindow(window: string): [number, number] {
  const [start = '09:00', end = '17:00'] = window.split('–');
  const minutes = (clock: string) => {
    const [h = '0', m = '0'] = clock.split(':');
    return Number(h) * 60 + Number(m);
  };
  return [minutes(start), minutes(end)];
}

const identities: CampaignSendingIdentity[] = [];

/** The mock identity for an address, created on first use. */
function identityFor(email: string) {
  let found = identities.find((identity) => identity.fromEmail === email);
  if (!found) {
    found = {
      id: uuid(),
      transport: 'smtp',
      fromEmail: email,
      fromName: 'Northwind Events',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      username: email,
      verifiedAt: now(),
      createdAt: now(),
    };
    identities.push(found);
  }
  return found;
}

const EVENT_KIND: Partial<
  Record<CampaignRecipientState, CampaignEvent['kind']>
> = {
  replied: 'replied',
  bounced: 'bounced',
  unsubscribed: 'unsubscribed',
};

/** Recent activity made up from the recipients: their outcome, then sends and opens. */
function buildEvents(
  recipients: CampaignRecipient[],
  steps: CampaignStep[],
  id: string
) {
  const events: CampaignEvent[] = [];
  recipients.forEach((recipient, index) => {
    const step =
      steps[
        Math.max(0, Math.min(steps.length - 1, recipient.nextPosition - 2))
      ];
    const base =
      Date.now() - Math.floor(hash(`${id}:${recipient.rowId}`) * 4 * DAY_MS);
    const push = (kind: CampaignEvent['kind'], offset: number) =>
      events.push({
        id: `${recipient.rowId}-${kind}`,
        kind,
        at: new Date(base - offset).toISOString(),
        email: recipient.email,
        name: recipient.name,
        stepId: step?.id ?? null,
      });
    if (!steps.length) return;
    push('sent', 3 * 3_600_000);
    if (index % 3 !== 2) push('opened', 2 * 3_600_000);
    const outcome = EVENT_KIND[recipient.state];
    if (outcome) push(outcome, 0);
  });
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

const REPLY_DRAFT_BODY = (name: string | null) =>
  `Hi ${name?.split(' ')[0] ?? 'there'},

Thanks for getting back to me. Happy to share the details — would Thursday at 10:00 or Friday at 15:00 suit you for a 15-minute call?

Best,
Northwind Events`;

function build(sample: Campaign): Entry {
  const details = campaignDetails(sample);
  const [windowStartMinute, windowEndMinute] = parseWindow(sample.window);
  const status = STATUS[sample.status];
  const createdAt = new Date(
    Date.now() - details.createdDaysAgo * DAY * 60_000
  ).toISOString();
  const settings: CampaignSettings = {
    timeZone: 'UTC',
    timeZoneColumnId: null,
    windowStartMinute,
    windowEndMinute,
    sendDays: 0b001_1111,
    stopOnReply: true,
    trackOpens: details.trackOpens,
    autoDraftReplies: sample.status === 'active',
  };
  const steps: CampaignStep[] = sample.steps.map((step, index) => ({
    id: `${sample.id}-${step.id}`,
    position: index + 1,
    delayMinutes:
      index === 0 ? 0 : (step.day - (sample.steps[index - 1]?.day ?? 0)) * DAY,
    subject: step.subject,
    bodyHtml: `<p>${step.subject}</p>`,
    bodyText: step.subject,
    bodyMacro: null,
    condition: index === 2 ? 'not_opened' : 'always',
  }));
  const recipients: CampaignRecipient[] = sampleLeads(sample).map(
    (lead, i) => ({
      rowId: lead.id,
      contactId: null,
      email: lead.email,
      name: lead.name,
      timeZone: null,
      state: RECIPIENT[lead.status],
      nextPosition: lead.step + 1,
      nextSendAt:
        RECIPIENT[lead.status] === 'active' && status === 'active'
          ? new Date(Date.now() + (1 + (i % 9)) * 3 * 3600_000).toISOString()
          : null,
      enrolledAt: createdAt,
    })
  );
  const stats: CampaignStats = {
    enrolled: sample.people,
    active: Math.max(0, sample.people - sample.sent),
    completed: status === 'completed' ? sample.people : 0,
    replied: sample.replied,
    bounced: sample.bounced,
    unsubscribed: 0,
    failed: 0,
    sent: sample.sent,
    opened: Math.round(sample.sent * 0.42),
    steps: sample.steps.map((step, index) => ({
      stepId: steps[index]?.id ?? step.id,
      sent: step.sent,
      opened: Math.round(step.sent * 0.42),
      replied: step.replied,
      bounced: 0,
    })),
  };
  return {
    campaign: {
      id: sample.id,
      teamId: team.team.id,
      userId: user.id,
      name: sample.name,
      status,
      databaseId: uuid(),
      tableId: uuid(),
      primaryColumnId: uuid(),
      sharing: 'private',
      settings,
      launchedAt: status === 'draft' ? null : createdAt,
      createdAt,
      trashedAt: null,
      grant: 'owner',
    },
    steps,
    senders: details.inboxes.map((email) => ({
      mailbox: { kind: 'identity', identity_id: identityFor(email).id },
      dailyCap: Math.max(details.dailyLimit, 300),
    })),
    recipients,
    stats,
    enrollable: sample.people,
    events: status === 'draft' ? [] : buildEvents(recipients, steps, sample.id),
    drafts: settings.autoDraftReplies
      ? recipients
          .filter((recipient) => recipient.state === 'replied')
          .slice(0, 3)
          .map((recipient, index) => ({
            id: `${recipient.rowId}-draft`,
            email: recipient.email,
            name: recipient.name,
            status: index === 0 ? 'pending' : 'ready',
            subject: `Re: ${steps[0]?.subject ?? ''}`,
            body: index === 0 ? '' : REPLY_DRAFT_BODY(recipient.name),
            createdAt: new Date(Date.now() - index * 3_600_000).toISOString(),
          }))
      : [],
  };
}

/* ------------------------------- daily stats ------------------------------ */

const MAX_DAILY_DAYS = 366;
/** Longest stretch a launched campaign's totals are spread over. */
const ACTIVE_SPAN_DAYS = 60;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Calendar date of an instant in an IANA zone (`Intl` throws on a bad zone). */
function dateIn(instant: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function hash(text: string) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** Split `total` across `weights` so the parts are whole and add up exactly. */
function spread(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

/**
 * One campaign's per-day counts: its all-time totals spread over the days since
 * launch (weekdays heavier, opens/replies/bounces trailing sends), so a range
 * covering the whole span sums to the totals.
 */
function dailyCounts(e: Entry, tz: string) {
  const counts = new Map<
    string,
    { sent: number; opened: number; replied: number; bounced: number }
  >();
  // A sample draft can carry totals without ever launching; date it from creation.
  const since = e.campaign.launchedAt ?? e.campaign.createdAt;
  const today = dateMs(dateIn(new Date(), tz));
  const launched = dateMs(dateIn(new Date(since), tz));
  const start = Math.max(launched, today - (ACTIVE_SPAN_DAYS - 1) * DAY_MS);
  const days: string[] = [];
  for (let ms = start; ms <= today; ms += DAY_MS) days.push(dateOf(ms));
  const weights = (kind: string, lag: number) =>
    days.map((date, index) => {
      const source = days[Math.max(0, index - lag)] ?? date;
      const weekday = new Date(dateMs(source)).getUTCDay();
      const quiet = weekday === 0 || weekday === 6 ? 0.25 : 1;
      return quiet * (0.4 + hash(`${e.campaign.id}:${kind}:${source}`));
    });
  const sent = spread(e.stats.sent, weights('sent', 0));
  const opened = spread(e.stats.opened, weights('sent', 1));
  const replied = spread(e.stats.replied, weights('sent', 2));
  const bounced = spread(e.stats.bounced, weights('sent', 0));
  days.forEach((date, index) => {
    counts.set(date, {
      sent: sent[index] ?? 0,
      opened: opened[index] ?? 0,
      replied: replied[index] ?? 0,
      bounced: bounced[index] ?? 0,
    });
  });
  return counts;
}

const badRequest = (message: string) =>
  new Response(JSON.stringify({ message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

/** The daily series for these campaigns, or a 400 like the backend's. */
function dailySeries(search: URLSearchParams, campaigns: Entry[]) {
  const from = search.get('from') ?? '';
  const to = search.get('to') ?? '';
  const tz = search.get('tz') || 'UTC';
  if (
    !DATE.test(from) ||
    !DATE.test(to) ||
    Number.isNaN(dateMs(from) + dateMs(to))
  ) {
    return badRequest('Pass from and to as YYYY-MM-DD');
  }
  if (from > to) return badRequest('Start the range on or before its end');
  if ((dateMs(to) - dateMs(from)) / DAY_MS + 1 > MAX_DAILY_DAYS) {
    return badRequest('Ask for at most 366 days at a time');
  }
  try {
    dateIn(new Date(), tz);
  } catch {
    return badRequest('Use an IANA time zone such as America/New_York');
  }
  const perCampaign = campaigns.map((e) => dailyCounts(e, tz));
  const days: CampaignDailyStats['days'] = [];
  for (let ms = dateMs(from); ms <= dateMs(to); ms += DAY_MS) {
    const date = dateOf(ms);
    const day = { date, sent: 0, opened: 0, replied: 0, bounced: 0 };
    for (const counts of perCampaign) {
      const found = counts.get(date);
      if (!found) continue;
      day.sent += found.sent;
      day.opened += found.opened;
      day.replied += found.replied;
      day.bounced += found.bounced;
    }
    days.push(day);
  }
  return { days } satisfies CampaignDailyStats;
}

function register(id: string) {
  const at = (path = '') => `${BASE}/${id}${path}`;
  const entry = () => entries.get(id);
  route(`GET ${at()}`, () => entry()?.campaign ?? notFound());
  route(`PUT ${at('/name')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    e.campaign.name = String((body as { name?: string })?.name ?? '');
    return noContent();
  });
  route(`PUT ${at('/sharing')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    e.campaign.sharing =
      (body as { sharing?: 'private' | 'team' })?.sharing ?? 'private';
    return noContent();
  });
  route(`PUT ${at('/trash')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    const trashed = Boolean((body as { trashed?: boolean })?.trashed);
    e.campaign.trashedAt = trashed ? now() : null;
    if (trashed && e.campaign.status === 'active') e.campaign.status = 'paused';
    return noContent();
  });
  route(`PUT ${at('/settings')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    e.campaign.settings = body as CampaignSettings;
    return noContent();
  });
  route(`GET ${at('/steps')}`, () => entry()?.steps ?? notFound());
  route(`PUT ${at('/steps')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    const known = new Set(e.steps.map((step) => step.id));
    e.steps = ((body ?? []) as CampaignStepInput[]).map((input, index) => ({
      id: input.id && known.has(input.id) ? input.id : uuid(),
      position: index + 1,
      delayMinutes: input.delayMinutes ?? 0,
      subject: input.subject ?? '',
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText ?? null,
      bodyMacro: input.bodyMacro ?? null,
      condition: input.condition ?? 'always',
    }));
    const before = new Map(e.stats.steps.map((s) => [s.stepId, s]));
    e.stats.steps = e.steps.map(
      (step) =>
        before.get(step.id) ?? {
          stepId: step.id,
          sent: 0,
          opened: 0,
          replied: 0,
          bounced: 0,
        }
    );
    return e.steps;
  });
  route(`GET ${at('/senders')}`, () => entry()?.senders ?? notFound());
  route(`PUT ${at('/senders')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    e.senders = (body ?? []) as CampaignSender[];
    return e.senders;
  });
  route(`POST ${at('/launch')}`, () => {
    const e = entry();
    if (!e) return notFound();
    const first = e.campaign.launchedAt === null;
    e.campaign.status = 'active';
    e.campaign.launchedAt ??= now();
    const enrolled = first ? e.enrollable : 0;
    e.stats.enrolled = Math.max(e.stats.enrolled, e.enrollable);
    e.stats.active = Math.max(e.stats.active, enrolled);
    return { enrolled, skipped: 0 };
  });
  route(`GET ${at('/check')}`, () => {
    const e = entry();
    if (!e) return notFound();
    const problems: { kind: string; message: string; stepId?: string }[] = [];
    if (e.steps.length === 0)
      problems.push({
        kind: 'no_steps',
        message: 'The sequence has no emails.',
      });
    for (const step of e.steps) {
      if (!step.subject.trim())
        problems.push({
          kind: 'empty_subject',
          message: `Email ${step.position} has no subject.`,
          stepId: step.id,
        });
    }
    if (e.senders.length === 0)
      problems.push({
        kind: 'no_senders',
        message: 'No inbox is picked to send from.',
      });
    if (e.enrollable === 0)
      problems.push({
        kind: 'no_recipients',
        message: 'Nobody is on the list yet.',
      });
    return { ready: problems.length === 0, problems };
  });
  route(`POST ${at('/test')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    const stepId = (body as { stepId?: string } | null)?.stepId;
    const to = (user as { email?: string }).email ?? 'you@example.com';
    return {
      sent: e.steps
        .filter((step) => !stepId || step.id === stepId)
        .map((step) => ({
          stepId: step.id,
          subject: `[Test] ${step.subject}`,
          to,
        })),
    };
  });
  route(`POST ${at('/pause')}`, () => {
    const e = entry();
    if (!e) return notFound();
    e.campaign.status = 'paused';
    return noContent();
  });
  route(`GET ${at('/recipients')}`, ({ search }) => {
    const e = entry();
    if (!e) return notFound();
    const after = search.get('after');
    const from = after
      ? e.recipients.findIndex((r) => r.rowId === after) + 1
      : 0;
    const recipients = e.recipients.slice(from, from + PAGE);
    const last = recipients.at(-1);
    return {
      recipients,
      next: last && from + PAGE < e.recipients.length ? last.rowId : null,
    };
  });
  route(`POST ${at('/recipients/remove')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    const ids = new Set((body as { rowIds?: string[] })?.rowIds ?? []);
    let removed = 0;
    for (const recipient of e.recipients) {
      if (ids.has(recipient.rowId) && recipient.state === 'active') {
        recipient.state = 'removed';
        removed += 1;
      }
    }
    e.stats.active = Math.max(0, e.stats.active - removed);
    return { removed };
  });
  route(`GET ${at('/rows')}`, () => {
    const e = entry();
    if (!e) return notFound();
    return { rows: rowsOf(e), next: null, version: 1 };
  });
  route(`POST ${at('/ops')}`, ({ body }) => {
    const e = entry();
    if (!e) return notFound();
    const { ops = [] } = (body ?? {}) as {
      ops?: { kind: string; change?: { kind: string; rows?: unknown[] } }[];
    };
    for (const op of ops)
      if (op.kind === 'rows' && op.change?.kind === 'insert')
        for (const _ of op.change.rows ?? []) rowsOf(e).push({ rowId: uuid() });
    return { version: 1 };
  });
  route(`GET ${at('/stats')}`, () => entry()?.stats ?? notFound());
  route(`GET ${at('/events')}`, ({ search }) => {
    const e = entry();
    if (!e) return notFound();
    const limit = Number(search.get('limit')) || 30;
    return { events: e.events.slice(0, limit) };
  });
  route(`GET ${at('/reply-drafts')}`, () => entry()?.drafts ?? notFound());
  // Drafts are registered as they appear; edits patch the draft in place.
  for (const draft of entry()?.drafts ?? []) {
    route(`PUT ${at(`/reply-drafts/${draft.id}`)}`, ({ body }) => {
      Object.assign(draft, body as Partial<CampaignReplyDraft>);
      return draft;
    });
  }
  route(`GET ${at('/stats/daily')}`, ({ search }) => {
    const e = entry();
    return e && e.campaign.trashedAt === null
      ? dailySeries(search, [e])
      : notFound();
  });
}

for (const sample of SAMPLE_CAMPAIGNS) {
  entries.set(sample.id, build(sample));
  register(sample.id);
}

route(`GET ${BASE}/stats/daily`, ({ search }) =>
  dailySeries(
    search,
    [...entries.values()].filter((e) => e.campaign.trashedAt === null)
  )
);

route(`GET ${BASE}`, () =>
  [...entries.values()]
    .filter((e) => e.campaign.trashedAt === null)
    .map((e) => e.campaign)
);

route(`POST ${BASE}`, ({ body }) => {
  const input = (body ?? {}) as { name?: string; sharing?: 'private' | 'team' };
  const id = uuid();
  const created = build({
    ...SAMPLE_CAMPAIGNS[3]!,
    id,
    name: input.name?.trim() || 'Untitled campaign',
    status: 'draft',
    people: 0,
    steps: [],
  });
  created.campaign.sharing = input.sharing ?? 'private';
  created.campaign.launchedAt = null;
  created.campaign.createdAt = now();
  entries.set(id, created);
  register(id);
  return created.campaign;
});

route(`GET ${BASE}/identities`, () => identities);

// SendGrid: one key per account; any key starting "SG." is accepted.
let sendgrid: CampaignSendgridAccount = {
  connected: false,
  checkedAt: null,
  domains: [],
  verifiedSenders: [],
};
route(`GET ${BASE}/sendgrid`, () => sendgrid);
route(`PUT ${BASE}/sendgrid`, ({ body }) => {
  const key = (body as { apiKey?: string } | undefined)?.apiKey ?? '';
  if (!key.startsWith('SG.'))
    return badRequest(
      'SendGrid refused this key. Check it has Mail Send access.'
    );
  sendgrid = {
    connected: true,
    checkedAt: now(),
    domains: [
      { domain: 'example.com', valid: true },
      { domain: 'northwind.example', valid: true },
      { domain: 'northwind-events.example', valid: false },
    ],
    verifiedSenders: ['founder@gmail.com'],
  };
  return sendgrid;
});
route(`POST ${BASE}/sendgrid/senders`, ({ body }) => {
  const input = (body ?? {}) as { fromEmail?: string; fromName?: string };
  const email = input.fromEmail?.trim() ?? '';
  const problem = sendgridProblem(checkSendgridSender(sendgrid, email));
  if (problem) return badRequest(problem);
  const same = identities.findIndex(
    (identity) => identity.fromEmail.toLowerCase() === email.toLowerCase()
  );
  if (same >= 0 && identities[same].transport === 'sendgrid')
    return identities[same];
  if (same >= 0) identities.splice(same, 1);
  const identity: CampaignSendingIdentity = {
    id: uuid(),
    transport: 'sendgrid',
    fromEmail: email,
    fromName: input.fromName ?? null,
    smtpHost: null,
    smtpPort: null,
    imapHost: null,
    imapPort: null,
    username: null,
    verifiedAt: now(),
    createdAt: now(),
  };
  identities.push(identity);
  return identity;
});

route('POST /dss/crm/contacts', ({ body }) => {
  const input = (body ?? {}) as { name?: string; email?: string };
  return { id: uuid(), name: input.name, email: input.email };
});

route(`POST ${BASE}/identities`, ({ body }) => {
  const input = (body ?? {}) as Partial<CampaignSendingIdentity> & {
    secret?: string;
  };
  // Like the backend: a SendGrid key without Mail Send access is refused.
  if (input.transport === 'sendgrid' && !input.secret?.startsWith('SG.'))
    return badRequest(
      'SendGrid refused this API key. Check it has Mail Send access.'
    );
  const same = identities.findIndex(
    (identity) =>
      identity.fromEmail.toLowerCase() === input.fromEmail?.toLowerCase()
  );
  if (same >= 0) identities.splice(same, 1);
  const identity: CampaignSendingIdentity = {
    id: uuid(),
    transport: input.transport ?? 'smtp',
    fromEmail: input.fromEmail ?? 'sender@northwind.example',
    fromName: input.fromName ?? null,
    smtpHost: input.smtpHost ?? null,
    smtpPort: input.smtpPort ?? null,
    imapHost: input.imapHost ?? null,
    imapPort: input.imapPort ?? null,
    username: input.username ?? null,
    verifiedAt: now(),
    createdAt: now(),
  };
  identities.push(identity);
  return identity;
});

// Connected Macro inboxes, for the campaign sender picker.
const mockLink = (
  id: string,
  email: string,
  provider: 'GMAIL' | 'OUTLOOK',
  primary: boolean
) => ({
  id,
  email_address: email,
  provider,
  is_primary: primary,
  is_sync_active: true,
  macro_id: 'macro|dev@macro.com',
  fusionauth_user_id: 'dev',
  calendar_disabled: false,
  has_calendar_data: false,
  needs_calendar_permission: false,
  needs_reauth: false,
  sync_status: 'UP_TO_DATE',
  settings: {},
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
});
route('GET /email/links', () => ({
  links: [
    mockLink('link-1', 'ujjwal@northwind.example', 'GMAIL', true),
    mockLink('link-2', 'sales@northwind.example', 'GMAIL', false),
    mockLink('link-3', 'events@northwind-events.example', 'OUTLOOK', false),
  ],
}));
