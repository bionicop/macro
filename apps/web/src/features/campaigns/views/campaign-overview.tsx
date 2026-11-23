import ArrowRightIcon from '@icon/system/regular/arrow-right.svg';
import WarningIcon from '@icon/system/regular/warning-circle.svg';
import { Button, cn, Tooltip } from '@ui';
import { createMemo, For, type JSX, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Card } from '../components/card';
import { Meter } from '../components/sparkline';
import { TemplateText } from '../components/template-text';
import { formatCount, formatShare, STATUS, stepTitle } from '../core/format';
import {
  dateIn,
  formatSendDays,
  lastDays,
  windowState,
} from '../core/schedule';
import type { CampaignSection } from '../core/sections';
import {
  delayMinutesToDays,
  minutesToClock,
  type CampaignStats as Stats,
  useCampaignDailyStatsQuery,
  useCampaignIdentitiesQuery,
  useCampaignQuery,
  useCampaignReplyDraftsQuery,
  useCampaignSendersQuery,
  useCampaignStatsQuery,
  useCampaignStepsQuery,
} from '../queries';
import { sendDaysToList } from '../queries/mapping';

const BOUNCE_LIMIT = 0.02;
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const CONDITION_LABEL = {
  not_opened: 'Only if not opened',
  opened: 'Only if opened',
} as const;

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * The whole campaign on one screen: what it is, where everyone stands, how
 * each email is doing and how it sends. Detail lives in the other tabs.
 */
export function CampaignOverview(props: {
  campaignId: string;
  onOpenSection: (section: CampaignSection) => void;
  /** Opens one email's report: who got it and what they got. */
  onOpenStep: (stepId: string) => void;
}) {
  const id = () => props.campaignId;
  const campaign = useCampaignQuery(id);
  const stats = useCampaignStatsQuery(id);
  const steps = useCampaignStepsQuery(id);
  const senders = useCampaignSendersQuery(id);
  const identities = useCampaignIdentitiesQuery();
  const drafts = useCampaignReplyDraftsQuery(id);

  const settings = () => campaign.data?.settings;
  const tz = () => settings()?.timeZone ?? 'UTC';
  const range = createMemo(() => lastDays(1, tz()));
  const daily = useCampaignDailyStatsQuery(id, range);
  const sentToday = () =>
    daily.data?.days.find((day) => day.date === dateIn(new Date(), tz()))
      ?.sent ?? 0;

  const senderRows = createMemo(() =>
    (senders.data ?? []).map((sender) => {
      let label = 'Connected mailbox';
      if (sender.mailbox.kind === 'identity') {
        const identityId = sender.mailbox.identity_id;
        label =
          identities.data?.find((i) => i.id === identityId)?.fromEmail ??
          'Sending identity';
      }
      return { label, cap: sender.dailyCap };
    })
  );
  const capacity = () =>
    senderRows().reduce((total, sender) => total + sender.cap, 0);
  const tracked = () => settings()?.trackOpens !== false;

  const plan = createMemo(() => {
    const byStep = new Map(stats.data?.steps.map((s) => [s.stepId, s]));
    const ordered = [...(steps.data ?? [])].sort(
      (a, b) => a.position - b.position
    );
    // Day 1 is the first send, as the sequence canvas counts.
    let day = 1;
    return ordered.map((step, index) => {
      day += delayMinutesToDays(step.delayMinutes);
      const s = byStep.get(step.id);
      return {
        id: step.id,
        title: stepTitle(index, ordered.length),
        subject: step.subject,
        condition: step.condition,
        day,
        sent: s?.sent ?? 0,
        opened: s?.opened ?? 0,
        replied: s?.replied ?? 0,
        bounced: s?.bounced ?? 0,
      };
    });
  });

  const waiting = () =>
    (drafts.data ?? []).filter(
      (draft) => draft.status === 'pending' || draft.status === 'ready'
    ).length;

  const attention = createMemo(() => {
    const notes: { text: string; section: CampaignSection }[] = [];
    const s = stats.data;
    if (steps.isSuccess && !steps.data.length)
      notes.push({
        text: 'No emails in the sequence yet',
        section: 'sequence',
      });
    if (senders.isSuccess && !senders.data.length)
      notes.push({ text: 'No inbox to send from', section: 'settings' });
    if (s && s.sent >= 50 && s.bounced / s.sent > BOUNCE_LIMIT)
      notes.push({
        text: `${formatShare(s.bounced, s.sent)} of emails bounced, above the 2% that keeps inboxes safe`,
        section: 'people',
      });
    if (waiting())
      notes.push({
        text: `${formatCount(waiting())} ${waiting() === 1 ? 'reply is' : 'replies are'} waiting for an answer`,
        section: 'people',
      });
    return notes;
  });

  return (
    <div class="h-full overflow-y-auto px-4 pt-4 pb-10 scrollbar-hidden @container/overview">
      <div class="mx-auto flex max-w-7xl min-w-0 flex-col gap-4">
        <Show when={campaign.data}>
          {(loaded) => (
            <Hero
              status={loaded().status}
              launchedAt={loaded().launchedAt}
              people={stats.data?.enrolled ?? 0}
              emails={plan().length}
              lastDay={plan().at(-1)?.day ?? 0}
              senders={senderRows().map((row) => row.label)}
              sentToday={sentToday()}
              capacity={capacity()}
              window={settings() ? windowState(settings()!) : undefined}
              timeZone={tz()}
            />
          )}
        </Show>

        <For each={attention()}>
          {(note) => (
            <button
              type="button"
              onClick={() => props.onOpenSection(note.section)}
              class="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-left text-sm not-touch:hover:bg-warning/12"
            >
              <WarningIcon class="size-4 shrink-0 text-warning" />
              <span class="min-w-0 flex-1 truncate">{note.text}</span>
              <ArrowRightIcon class="size-3.5 shrink-0 text-ink-muted" />
            </button>
          )}
        </For>

        <div class="overflow-hidden rounded-xl border border-edge-muted @container/insight-main">
          <Totals
            stats={stats.data}
            opensTracked={tracked()}
            onOpenPeople={() => props.onOpenSection('people')}
          />
        </div>

        <div class="grid min-w-0 grid-cols-1 items-start gap-4 @4xl/overview:grid-cols-[minmax(0,1fr)_20rem]">
          <div class="flex min-w-0 flex-col gap-4">
            <Card
              title="Emails"
              description="Each email of the sequence and how it is doing"
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onOpenSection('sequence')}
                >
                  Edit sequence
                </Button>
              }
            >
              <EmailTable
                rows={plan()}
                opensTracked={tracked()}
                onOpen={props.onOpenStep}
              />
            </Card>
          </div>

          <Show when={campaign.data}>
            {(loaded) => (
              <Card
                title="At a glance"
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => props.onOpenSection('settings')}
                  >
                    Edit
                  </Button>
                }
              >
                <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 px-4 pt-1 pb-4 text-sm">
                  <Glance label="Sends from">
                    <Show when={senderRows().length} fallback="—">
                      <span class="ph-no-capture flex min-w-0 flex-col">
                        <For each={senderRows()}>
                          {(sender) => (
                            <span class="truncate">{sender.label}</span>
                          )}
                        </For>
                      </span>
                    </Show>
                  </Glance>
                  <Glance label="Daily limit">
                    {capacity() ? `${formatCount(capacity())} a day` : '—'}
                  </Glance>
                  <Glance label="Days">
                    <WeekPills mask={loaded().settings.sendDays} />
                  </Glance>
                  <Glance label="Hours">
                    {minutesToClock(loaded().settings.windowStartMinute)}–
                    {minutesToClock(loaded().settings.windowEndMinute)}
                    <span class="block text-xs text-ink-muted">
                      {loaded().settings.timeZone}
                    </span>
                  </Glance>
                  <Glance label="On reply">
                    {loaded().settings.stopOnReply
                      ? 'Stops the sequence'
                      : 'Keeps sending'}
                  </Glance>
                  <Glance label="Opens">
                    {loaded().settings.trackOpens ? 'Tracked' : 'Not tracked'}
                  </Glance>
                  <Glance label="Reply drafts">
                    {loaded().settings.autoDraftReplies
                      ? 'Drafted for review'
                      : 'Off'}
                  </Glance>
                  <Glance label="Launched">
                    {loaded().launchedAt
                      ? longDate(loaded().launchedAt!)
                      : 'Not yet'}
                  </Glance>
                  <Glance label="Last email">
                    {plan().length ? `Day ${plan().at(-1)!.day}` : '—'}
                  </Glance>
                </dl>
              </Card>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

/** What the campaign is, in one sentence, beside today's sending. */
function Hero(props: {
  status: keyof typeof STATUS;
  launchedAt: string | null;
  people: number;
  emails: number;
  lastDay: number;
  senders: string[];
  sentToday: number;
  capacity: number;
  window?: { open: boolean; label: string };
  timeZone: string;
}) {
  const status = () => STATUS[props.status];
  const running = () =>
    props.launchedAt
      ? Math.max(
          1,
          Math.ceil((Date.now() - Date.parse(props.launchedAt)) / 86_400_000)
        )
      : 0;
  const live = () => props.status === 'active' || props.status === 'paused';
  return (
    <section
      aria-label="Campaign"
      class="grid min-w-0 grid-cols-1 overflow-hidden rounded-xl border border-edge-muted @3xl/overview:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <div class="flex min-w-0 flex-col gap-2 px-5 py-4">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
          <span class="flex items-center gap-1.5 font-medium">
            <span
              class={cn(
                'size-2 rounded-full',
                props.status === 'active' &&
                  props.window?.open &&
                  'animate-pulse'
              )}
              style={{ background: status().fill }}
            />
            <span class={status().tone}>{status().label}</span>
          </span>
          <span>·</span>
          <span>
            {props.launchedAt
              ? `Launched ${longDate(props.launchedAt)} · day ${running()}`
              : 'Not launched yet'}
          </span>
        </div>
        <p class="text-lg leading-snug text-ink-muted">
          <span class="font-medium text-ink tabular-nums">
            {formatCount(props.people)}
          </span>{' '}
          {props.people === 1 ? 'person gets' : 'people get'}{' '}
          <span class="font-medium text-ink tabular-nums">{props.emails}</span>{' '}
          {props.emails === 1 ? 'email' : 'emails'}
          <Show when={props.lastDay > 1}>
            {' '}
            over{' '}
            <span class="font-medium text-ink tabular-nums">
              {props.lastDay}
            </span>{' '}
            days
          </Show>
          <Show when={props.senders.length}>
            , from{' '}
            <span class="ph-no-capture font-medium text-ink">
              {props.senders[0]}
            </span>
            <Show when={props.senders.length > 1}>
              <Tooltip label={props.senders.slice(1).join(', ')}>
                <span class="text-ink">
                  {' '}
                  and {props.senders.length - 1} more
                </span>
              </Tooltip>
            </Show>
          </Show>
        </p>
      </div>
      <div class="flex min-w-0 flex-col justify-center gap-2 border-edge-muted bg-hover/40 px-5 py-4 max-@3xl/overview:border-t @3xl/overview:border-l">
        <Show
          when={props.status !== 'draft'}
          fallback={
            <span class="text-sm text-ink-muted">
              Sends up to {formatCount(props.capacity)} a day once launched
            </span>
          }
        >
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm text-ink-muted">
              <span class="text-2xl font-medium text-ink tabular-nums">
                {formatCount(props.sentToday)}
              </span>
              {props.capacity
                ? ` of ${formatCount(props.capacity)} today`
                : ' today'}
            </span>
            <span class="text-xs text-ink-muted tabular-nums">
              {!props.capacity
                ? ''
                : props.sentToday >= props.capacity
                  ? 'Limit reached'
                  : `${formatCount(props.capacity - props.sentToday)} left`}
            </span>
          </div>
          <Meter
            value={Math.min(props.sentToday, props.capacity || props.sentToday)}
            max={Math.max(1, props.capacity || props.sentToday)}
          />
          <Show when={live()}>
            <span
              class={cn(
                'text-xs',
                props.window?.open && props.status === 'active'
                  ? 'text-success'
                  : 'text-ink-muted'
              )}
            >
              {props.status === 'paused'
                ? 'Paused, nothing is sending'
                : props.window?.label}{' '}
              <span class="text-ink-extra-muted">· {props.timeZone}</span>
            </span>
          </Show>
        </Show>
      </div>
    </section>
  );
}

const EMAIL_COLUMNS =
  'grid grid-cols-[3rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem_4.5rem] items-center gap-3 px-4';

/**
 * One row per email, in order: when it goes, what it says, and how many got,
 * opened, answered or bounced it. Under "Sent", how many fewer people got it
 * than the email before, since a reply, bounce or stop ends the sequence.
 */
function EmailTable(props: {
  rows: {
    id: string;
    title: string;
    subject: string;
    condition?: 'always' | 'not_opened' | 'opened';
    day: number;
    sent: number;
    opened: number;
    replied: number;
    bounced: number;
  }[];
  opensTracked: boolean;
  onOpen: (stepId: string) => void;
}) {
  const share = (part: number, whole: number) =>
    whole ? formatShare(part, whole) : '';
  return (
    <Show
      when={props.rows.length}
      fallback={
        <p class="px-4 pt-2 pb-6 text-sm text-ink-muted">
          No emails yet. Write the first one in the sequence.
        </p>
      }
    >
      <div role="table" aria-label="Emails" class="pb-2 text-sm">
        <div
          role="row"
          class={`${EMAIL_COLUMNS} h-8 border-b border-edge-muted text-xs text-ink-muted`}
        >
          <span role="columnheader">Day</span>
          <span role="columnheader">Email</span>
          <span role="columnheader" class="text-right">
            Sent
          </span>
          <span role="columnheader" class="text-right">
            Opened
          </span>
          <span role="columnheader" class="text-right">
            Replied
          </span>
          <span role="columnheader" class="text-right">
            Bounced
          </span>
        </div>
        <For each={props.rows}>
          {(row, index) => {
            const before = () => props.rows[index() - 1]?.sent;
            const dropped = () => {
              const prior = before();
              return prior !== undefined && prior > row.sent
                ? prior - row.sent
                : 0;
            };
            return (
              <button
                type="button"
                role="row"
                onClick={() => props.onOpen(row.id)}
                class={`${EMAIL_COLUMNS} h-12 w-full border-b border-edge-muted/60 text-left last:border-b-0 not-touch:hover:bg-hover`}
              >
                <span role="cell" class="text-ink-muted tabular-nums">
                  Day {row.day}
                </span>
                <span role="cell" class="flex min-w-0 flex-col">
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="shrink-0 font-medium">{row.title}</span>
                    <Show when={row.condition && row.condition !== 'always'}>
                      <span class="shrink-0 rounded bg-hover px-1.5 text-xs text-ink-muted">
                        {
                          CONDITION_LABEL[
                            row.condition as keyof typeof CONDITION_LABEL
                          ]
                        }
                      </span>
                    </Show>
                  </span>
                  <span class="truncate text-xs text-ink-muted">
                    <Show when={row.subject} fallback="No subject yet">
                      <TemplateText text={row.subject} />
                    </Show>
                  </span>
                </span>
                <span role="cell" class="flex flex-col text-right tabular-nums">
                  {formatCount(row.sent)}
                  <Show when={dropped()}>
                    <span
                      class="text-xs text-ink-extra-muted"
                      title="Fewer than the email before: they replied, bounced or stopped"
                    >
                      −{formatCount(dropped())}
                    </span>
                  </Show>
                </span>
                <span role="cell" class="flex flex-col text-right tabular-nums">
                  {props.opensTracked ? formatCount(row.opened) : '—'}
                  <span class="text-xs text-ink-extra-muted">
                    {props.opensTracked ? share(row.opened, row.sent) : ''}
                  </span>
                </span>
                <span role="cell" class="flex flex-col text-right tabular-nums">
                  <span class={row.replied ? 'text-success' : undefined}>
                    {formatCount(row.replied)}
                  </span>
                  <span class="text-xs text-ink-extra-muted">
                    {share(row.replied, row.sent)}
                  </span>
                </span>
                <span role="cell" class="flex flex-col text-right tabular-nums">
                  <span
                    class={
                      row.sent && row.bounced / row.sent > BOUNCE_LIMIT
                        ? 'text-failure'
                        : undefined
                    }
                  >
                    {formatCount(row.bounced)}
                  </span>
                  <span class="text-xs text-ink-extra-muted">
                    {share(row.bounced, row.sent)}
                  </span>
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** Monday to Sunday, the sending days filled in. */
function WeekPills(props: { mask: number }) {
  const days = () => new Set(sendDaysToList(props.mask));
  return (
    <span class="flex gap-1" aria-label={formatSendDays(props.mask)}>
      <For each={DAY_LETTERS}>
        {(letter, index) => (
          <Tooltip label={DAY_NAMES[index()]!}>
            <span
              class={cn(
                'grid size-5 place-items-center rounded text-[10px] font-medium',
                days().has(index())
                  ? 'bg-accent/15 text-accent'
                  : 'bg-hover text-ink-extra-muted'
              )}
            >
              {letter}
            </span>
          </Tooltip>
        )}
      </For>
    </span>
  );
}

function Glance(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <dt class="text-ink-muted">{props.label}</dt>
      <dd class="min-w-0">{props.children}</dd>
    </>
  );
}

/** Lifetime totals: who is in it and what they did. */
function Totals(props: {
  stats?: Stats;
  opensTracked: boolean;
  onOpenPeople: () => void;
}) {
  const s = () => props.stats;
  const bounceHigh = () => {
    const t = s();
    return Boolean(t && t.sent >= 50 && t.bounced / t.sent > BOUNCE_LIMIT);
  };
  return (
    <div class="grid grid-cols-3 gap-px bg-edge-muted @2xl/insight-main:grid-cols-6">
      <Total
        label="People"
        value={formatCount(s()?.enrolled ?? 0)}
        onClick={props.onOpenPeople}
      />
      <Total
        label="In sequence"
        value={formatCount(s()?.active ?? 0)}
        note={
          s()?.completed ? `${formatCount(s()!.completed)} finished` : undefined
        }
        onClick={props.onOpenPeople}
      />
      <Total label="Emails sent" value={formatCount(s()?.sent ?? 0)} />
      <Total
        label="Replied"
        value={formatCount(s()?.replied ?? 0)}
        note={
          s()?.enrolled ? formatShare(s()!.replied, s()!.enrolled) : undefined
        }
        tone={s()?.replied ? 'success' : undefined}
      />
      <Total
        label="Bounced"
        value={formatCount(s()?.bounced ?? 0)}
        note={s()?.sent ? formatShare(s()!.bounced, s()!.sent) : undefined}
        tone={bounceHigh() ? 'failure' : undefined}
      />
      <Show
        when={props.opensTracked}
        fallback={<Total label="Open rate" value="Not tracked" muted />}
      >
        <Total
          label="Open rate"
          value={formatShare(s()?.opened ?? 0, s()?.sent ?? 0)}
          note={s()?.opened ? `${formatCount(s()!.opened)} opened` : undefined}
        />
      </Show>
    </div>
  );
}

export function Total(props: {
  label: string;
  value: string;
  note?: string;
  tone?: 'success' | 'failure';
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <Dynamic
      component={props.onClick ? 'button' : 'div'}
      type={props.onClick ? 'button' : undefined}
      onClick={props.onClick}
      class={cn(
        'flex min-w-0 flex-col gap-1 bg-panel px-4 py-3 text-left',
        props.onClick && 'not-touch:hover:bg-hover'
      )}
    >
      <span class="truncate text-xs text-ink-muted">{props.label}</span>
      <span class="flex items-baseline justify-between gap-2">
        <span
          class={cn(
            'truncate tabular-nums',
            props.muted ? 'text-base text-ink-extra-muted' : 'text-xl text-ink',
            props.tone === 'success' && 'text-success',
            props.tone === 'failure' && 'text-failure'
          )}
        >
          {props.value}
        </span>
        <Show when={props.note}>
          <span class="shrink-0 text-xs text-ink-muted tabular-nums">
            {props.note}
          </span>
        </Show>
      </span>
    </Dynamic>
  );
}
