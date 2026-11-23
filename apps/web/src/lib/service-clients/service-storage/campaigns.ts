/**
 * The `/campaigns` routes of `crates/campaign`, mounted by the document storage
 * service. Types mirror `domain/models.rs`; JSON is camelCase except where the
 * Rust notes otherwise.
 */
import type { DatabaseOp } from '@core/database-sql/generated/types';
import { dssFetch } from './client';
import type { AccessLevel } from './generated/schemas/accessLevel';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type CampaignSharing = 'private' | 'team';

/** When and how a campaign sends. */
export type CampaignSettings = {
  /** IANA zone of the sending window for recipients without their own. */
  timeZone: string;
  /** Recipient column holding each recipient's IANA zone. */
  timeZoneColumnId: string | null;
  /** Window start, minutes after local midnight. */
  windowStartMinute: number;
  /** Window end, minutes after local midnight, exclusive. */
  windowEndMinute: number;
  /** Allowed ISO weekdays, bit 0 = Monday. */
  sendDays: number;
  stopOnReply: boolean;
  trackOpens: boolean;
  /** Draft an answer to each reply for review; drafts are never sent on their own. */
  autoDraftReplies?: boolean;
};

/** Whether a step goes to everyone still in the sequence or depends on opens. */
export type CampaignStepCondition = 'always' | 'not_opened' | 'opened';

export type Campaign = {
  id: string;
  teamId: string;
  userId: string;
  name: string;
  status: CampaignStatus;
  databaseId: string;
  tableId: string;
  primaryColumnId: string;
  sharing: CampaignSharing;
  settings: CampaignSettings;
  /** ISO timestamp of the first launch. */
  launchedAt: string | null;
  createdAt: string;
  /** Trashed campaigns send nothing and are omitted from navigation. */
  trashedAt: string | null;
};

/** Metadata together with the caller's effective grant (flattened). */
export type AccessibleCampaign = Campaign & { grant: AccessLevel };

export type CreateCampaign = {
  name: string;
  /** Defaults to private. */
  sharing?: CampaignSharing;
};

/** One email of the sequence. */
export type CampaignStep = {
  id: string;
  /** 1-based order. */
  position: number;
  /** Wait after launch (step 1) or after the previous step's send. */
  delayMinutes: number;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  bodyMacro: string | null;
  /** Missing on servers that predate conditions; treat as `always`. */
  condition?: CampaignStepCondition;
};

/** A step as written by an editor; without an id it is new. */
export type CampaignStepInput = {
  id?: string | null;
  delayMinutes?: number;
  subject?: string;
  bodyHtml: string;
  bodyText?: string | null;
  bodyMacro?: string | null;
  condition?: CampaignStepCondition;
};

export type CampaignEventKind =
  | 'sent'
  | 'opened'
  | 'replied'
  | 'bounced'
  | 'unsubscribed';

/** One thing that happened to one recipient, newest first in lists. */
export type CampaignEvent = {
  id: string;
  kind: CampaignEventKind;
  at: string;
  email: string;
  name: string | null;
  stepId: string | null;
};

export type CampaignReplyDraftStatus =
  | 'pending'
  | 'ready'
  | 'dismissed'
  | 'sent';

/** An answer drafted for a recipient's reply, waiting for a person to review it. */
export type CampaignReplyDraft = {
  id: string;
  email: string;
  name: string | null;
  status: CampaignReplyDraftStatus;
  subject: string;
  body: string;
  createdAt: string;
};

/**
 * The mailbox a sender slot sends from. serde's `rename_all` on this enum only
 * renames the variants, so the variant fields stay snake_case on the wire.
 */
export type CampaignSenderMailbox =
  | { kind: 'link'; link_id: string }
  | { kind: 'identity'; identity_id: string };

export type CampaignSender = {
  mailbox: CampaignSenderMailbox;
  dailyCap: number;
};

export type CampaignRecipientState =
  | 'active'
  | 'completed'
  | 'replied'
  | 'bounced'
  | 'unsubscribed'
  | 'failed'
  | 'removed';

export type CampaignRecipient = {
  rowId: string;
  contactId: string | null;
  email: string;
  name: string | null;
  timeZone: string | null;
  state: CampaignRecipientState;
  /** The step sent next. */
  nextPosition: number;
  nextSendAt: string | null;
  enrolledAt: string;
};

/** One page of the people table; cells are left unread here. */
export type CampaignRowsPage = {
  rows: { rowId: string }[];
  next: string | null;
};

/** One page of recipients in row-id order. */
export type CampaignRecipientsPage = {
  recipients: CampaignRecipient[];
  /** Cursor (`after`) for the next page. */
  next: string | null;
};

export type CampaignStepStats = {
  stepId: string;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
};

export type CampaignStats = {
  enrolled: number;
  active: number;
  completed: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  failed: number;
  sent: number;
  opened: number;
  steps: CampaignStepStats[];
};

/** One calendar day of activity, dated in the requested zone. */
export type CampaignDailyStatsDay = {
  /** `YYYY-MM-DD`. */
  date: string;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
};

/** One entry per date in the range, zero days included, oldest first. */
export type CampaignDailyStats = { days: CampaignDailyStatsDay[] };

/** Inclusive `YYYY-MM-DD` dates (at most 366 days) and the IANA zone to cut days in. */
export type CampaignDailyRange = { from: string; to: string; tz: string };

export type LaunchCampaignInput = {
  /** The user's own words approving the launch; required from agents. */
  userConfirmation?: string | null;
};

export type LaunchOutcome = { enrolled: number; skipped: number };

/** Something that would stop a campaign from sending as written. */
export type CampaignProblem = {
  kind:
    | 'no_steps'
    | 'empty_subject'
    | 'empty_body'
    | 'unknown_merge_field'
    | 'no_senders'
    | 'no_recipients'
    | 'window_empty'
    | 'sender_cap_zero'
    | (string & {});
  message: string;
  stepId?: string;
};

/** Whether the campaign can launch, and what to fix first if not. */
export type CampaignCheck = { ready: boolean; problems: CampaignProblem[] };

/** Which step and row a test send renders; all steps and the first row by default. */
export type CampaignTestInput = { stepId?: string; rowId?: string };

/** Test emails go to the caller only, never to recipients, and count nowhere. */
export type CampaignTestResult = {
  sent: { stepId: string; subject: string; to: string }[];
};

export type CampaignIdentityTransport = 'smtp' | 'sendgrid';

/** An SMTP or SendGrid mailbox; the secret is never returned. */
export type CampaignSendingIdentity = {
  id: string;
  transport: CampaignIdentityTransport;
  fromEmail: string;
  fromName: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  imapHost: string | null;
  imapPort: number | null;
  username: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

export type CreateCampaignSendingIdentity = {
  transport: CampaignIdentityTransport;
  fromEmail: string;
  fromName?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  imapHost?: string | null;
  imapPort?: number | null;
  username?: string | null;
  /** SMTP password (an app password for Gmail) or SendGrid API key. */
  secret: string;
};

/** A domain set up under Sender Authentication in SendGrid. */
export type CampaignSendgridDomain = {
  domain: string;
  /** Its DNS records are verified, so any address on it can send. */
  valid: boolean;
};

/**
 * The SendGrid account connected for campaigns: one API key, stored
 * encrypted, and what SendGrid says it may send from.
 */
export type CampaignSendgridAccount = {
  connected: boolean;
  /** When the key and the lists below were last read from SendGrid. */
  checkedAt: string | null;
  domains: CampaignSendgridDomain[];
  /** Addresses verified one at a time (Single Sender Verification). */
  verifiedSenders: string[];
};

const json = (body: unknown) => ({ body: JSON.stringify(body) });

const dailyQuery = ({ from, to, tz }: CampaignDailyRange) =>
  new URLSearchParams({ from, to, tz }).toString();

export const campaignsClient = {
  list: () => dssFetch<AccessibleCampaign[]>('/campaigns', { method: 'GET' }),
  create: (input: CreateCampaign) =>
    dssFetch<AccessibleCampaign>('/campaigns', {
      method: 'POST',
      ...json(input),
    }),
  get: (id: string) =>
    dssFetch<AccessibleCampaign>(`/campaigns/${id}`, { method: 'GET' }),
  rename: (id: string, name: string) =>
    dssFetch(`/campaigns/${id}/name`, { method: 'PUT', ...json({ name }) }),
  share: (id: string, sharing: CampaignSharing) =>
    dssFetch(`/campaigns/${id}/sharing`, {
      method: 'PUT',
      ...json({ sharing }),
    }),
  /** `trashed: false` restores. Trashing an active campaign pauses it. */
  trash: (id: string, trashed: boolean) =>
    dssFetch(`/campaigns/${id}/trash`, { method: 'PUT', ...json({ trashed }) }),
  updateSettings: (id: string, settings: CampaignSettings) =>
    dssFetch(`/campaigns/${id}/settings`, {
      method: 'PUT',
      ...json(settings),
    }),
  getSteps: (id: string) =>
    dssFetch<CampaignStep[]>(`/campaigns/${id}/steps`, { method: 'GET' }),
  /** Replace the sequence; keep a step's `id` to edit it. */
  setSteps: (id: string, steps: CampaignStepInput[]) =>
    dssFetch<CampaignStep[]>(`/campaigns/${id}/steps`, {
      method: 'PUT',
      ...json(steps),
    }),
  getSenders: (id: string) =>
    dssFetch<CampaignSender[]>(`/campaigns/${id}/senders`, { method: 'GET' }),
  setSenders: (id: string, senders: CampaignSender[]) =>
    dssFetch<CampaignSender[]>(`/campaigns/${id}/senders`, {
      method: 'PUT',
      ...json(senders),
    }),
  /** Enroll the table's contacts and start or resume sending. */
  launch: (id: string, input: LaunchCampaignInput = {}) =>
    dssFetch<LaunchOutcome>(`/campaigns/${id}/launch`, {
      method: 'POST',
      ...json(input),
    }),
  /** What would stop the campaign from sending; empty when it is ready. */
  check: (id: string) =>
    dssFetch<CampaignCheck>(`/campaigns/${id}/check`, { method: 'GET' }),
  /** Send the rendered steps to the caller's own address, marked [Test]. */
  sendTest: (id: string, input: CampaignTestInput = {}) =>
    dssFetch<CampaignTestResult>(`/campaigns/${id}/test`, {
      method: 'POST',
      ...json(input),
    }),
  /** Stop sending; recipients keep their place. */
  pause: (id: string) => dssFetch(`/campaigns/${id}/pause`, { method: 'POST' }),
  getRecipients: (id: string, after?: string | null) =>
    dssFetch<CampaignRecipientsPage>(
      `/campaigns/${id}/recipients${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      { method: 'GET' }
    ),
  /** A page of the people table: rows added, enrolled or not. */
  getRows: (id: string, after?: string | null) =>
    dssFetch<CampaignRowsPage>(
      `/campaigns/${id}/rows${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      { method: 'GET' }
    ),
  /** Edit the people table with the common database ops. */
  applyOps: (id: string, ops: DatabaseOp[]) =>
    dssFetch<unknown>(`/campaigns/${id}/ops`, {
      method: 'POST',
      ...json({ ops }),
    }),
  removeRecipients: (id: string, rowIds: string[]) =>
    dssFetch<{ removed: number }>(`/campaigns/${id}/recipients/remove`, {
      method: 'POST',
      ...json({ rowIds }),
    }),
  getStats: (id: string) =>
    dssFetch<CampaignStats>(`/campaigns/${id}/stats`, { method: 'GET' }),
  /** Sent, opened, replied and bounced per day for one campaign. */
  getDailyStats: (id: string, range: CampaignDailyRange) =>
    dssFetch<CampaignDailyStats>(
      `/campaigns/${id}/stats/daily?${dailyQuery(range)}`,
      { method: 'GET' }
    ),
  /** The same series summed over every campaign the caller can see. */
  getAllDailyStats: (range: CampaignDailyRange) =>
    dssFetch<CampaignDailyStats>(
      `/campaigns/stats/daily?${dailyQuery(range)}`,
      {
        method: 'GET',
      }
    ),
  /** The latest sends, opens, replies and bounces, newest first. */
  getEvents: (id: string, limit = 30) =>
    dssFetch<{ events: CampaignEvent[] }>(
      `/campaigns/${id}/events?limit=${limit}`,
      { method: 'GET' }
    ),
  getReplyDrafts: (id: string) =>
    dssFetch<CampaignReplyDraft[]>(`/campaigns/${id}/reply-drafts`, {
      method: 'GET',
    }),
  updateReplyDraft: (
    id: string,
    draftId: string,
    patch: Partial<Pick<CampaignReplyDraft, 'subject' | 'body' | 'status'>>
  ) =>
    dssFetch<CampaignReplyDraft>(`/campaigns/${id}/reply-drafts/${draftId}`, {
      method: 'PUT',
      ...json(patch),
    }),
  listIdentities: () =>
    dssFetch<CampaignSendingIdentity[]>('/campaigns/identities', {
      method: 'GET',
    }),
  createIdentity: (input: CreateCampaignSendingIdentity) =>
    dssFetch<CampaignSendingIdentity>('/campaigns/identities', {
      method: 'POST',
      ...json(input),
    }),
  deleteIdentity: (id: string) =>
    dssFetch(`/campaigns/identities/${id}`, { method: 'DELETE' }),
  getSendgrid: () =>
    dssFetch<CampaignSendgridAccount>('/campaigns/sendgrid', {
      method: 'GET',
    }),
  /** Checks the key with SendGrid, stores it, and reads its domains. */
  connectSendgrid: (apiKey: string) =>
    dssFetch<CampaignSendgridAccount>('/campaigns/sendgrid', {
      method: 'PUT',
      ...json({ apiKey }),
    }),
  /**
   * A SendGrid sender for one address, using the connected key. Refused
   * unless the address is on an authenticated domain or verified itself;
   * the same address again returns the existing sender.
   */
  addSendgridSender: (input: { fromEmail: string; fromName?: string | null }) =>
    dssFetch<CampaignSendingIdentity>('/campaigns/sendgrid/senders', {
      method: 'POST',
      ...json(input),
    }),
};
