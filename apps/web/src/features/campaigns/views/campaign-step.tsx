import {
  RecordSection,
  RecordSectionFilters,
} from '@app/features/crm/components/record-section';
import EmptyStateEmailGraphic from '@design/empty-state-email.svg';
import EmptyStateNoSearchMatchGraphic from '@design/empty-state-no-search-match.svg';
import LockIcon from '@icon/system/regular/lock-simple.svg';
import PencilIcon from '@icon/system/regular/pencil-simple.svg';
import type { CampaignRecipient } from '@service-storage/campaigns';
import {
  Avatar,
  Button,
  ComposerSurface,
  cn,
  EmptyStatePanel,
  Tabs,
} from '@ui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
} from 'solid-js';
import { TemplateText } from '../components/template-text';
import {
  formatCount,
  formatRelative,
  formatShare,
  stepTitle,
} from '../core/format';
import { domainOf, fill, sentCount, valuesFor } from '../core/recipients';
import { htmlToText } from '../core/rows';
import type { CampaignSection } from '../core/sections';
import {
  delayMinutesToDays,
  useCampaignIdentitiesQuery,
  useCampaignQuery,
  useCampaignRecipientsQuery,
  useCampaignSendersQuery,
  useCampaignStatsQuery,
  useCampaignStepsQuery,
} from '../queries';

/** Everyone enrolled is loaded so the list and its filters are complete. */
const LOAD_LIMIT = 5000;

const CONDITION_LABEL = {
  not_opened: 'People who didn’t open the last one',
  opened: 'People who opened the last one',
} as const;

/** What happened to one person after this email. */
const OUTCOME = {
  replied: { label: 'Replied', fill: 'var(--color-success)' },
  bounced: { label: 'Bounced', fill: 'var(--color-failure)' },
  unsubscribed: { label: 'Asked to stop', fill: 'var(--color-warning)' },
  failed: { label: 'Send failed', fill: 'var(--color-ink-extra-muted)' },
  waiting: { label: 'No reply yet', fill: 'var(--color-accent)' },
  moved: { label: 'Got a later email', fill: 'var(--color-purple)' },
  finished: { label: 'Finished, no reply', fill: 'var(--color-purple)' },
  removed: { label: 'Removed', fill: 'var(--color-edge)' },
} as const;
type Outcome = keyof typeof OUTCOME;

/** The filter tabs, each a group of outcomes; empty groups are hidden. */
const FILTERS = [
  { value: 'all', label: 'Everyone', outcomes: [] },
  { value: 'replied', label: 'Replied', outcomes: ['replied'] },
  {
    value: 'quiet',
    label: 'No reply',
    outcomes: ['waiting', 'moved', 'finished'],
  },
  { value: 'bounced', label: 'Bounced', outcomes: ['bounced', 'failed'] },
  { value: 'stopped', label: 'Stopped', outcomes: ['unsubscribed', 'removed'] },
] as const satisfies readonly {
  value: string;
  label: string;
  outcomes: readonly Outcome[];
}[];
type Filter = (typeof FILTERS)[number]['value'];

const inFilter = (filter: Filter, outcome: Outcome) =>
  filter === 'all' ||
  (
    FILTERS.find((f) => f.value === filter)?.outcomes as
      | readonly Outcome[]
      | undefined
  )?.includes(outcome) === true;

/** Where someone who got email `position` (1-based) is now. */
function outcomeOf(
  recipient: CampaignRecipient,
  position: number,
  total: number
): Outcome {
  if (sentCount(recipient, total) > position) return 'moved';
  switch (recipient.state) {
    case 'replied':
    case 'bounced':
    case 'unsubscribed':
    case 'failed':
    case 'removed':
      return recipient.state;
    case 'completed':
      return 'finished';
    default:
      return position === total ? 'finished' : 'waiting';
  }
}

/**
 * One email of the sequence after it went out, laid out like Mail: the people
 * it went to on the left, and on the right how it did and the copy the chosen
 * person got. The header above carries the breadcrumb and item navigation.
 */
export function CampaignStepReport(props: {
  campaignId: string;
  stepId: string;
  onOpenStep: (stepId: string | undefined) => void;
  onOpenSection: (section: CampaignSection) => void;
}) {
  const id = () => props.campaignId;
  const campaign = useCampaignQuery(id);
  const steps = useCampaignStepsQuery(id);
  const stats = useCampaignStatsQuery(id);
  const senders = useCampaignSendersQuery(id);
  const identities = useCampaignIdentitiesQuery();
  const recipientsQuery = useCampaignRecipientsQuery(id);

  const recipients = createMemo(
    () => recipientsQuery.data?.pages.flatMap((page) => page.recipients) ?? []
  );
  createEffect(() => {
    if (
      recipientsQuery.hasNextPage &&
      !recipientsQuery.isFetchingNextPage &&
      recipients().length < LOAD_LIMIT
    )
      void recipientsQuery.fetchNextPage();
  });

  const ordered = createMemo(() =>
    [...(steps.data ?? [])].sort((a, b) => a.position - b.position)
  );
  const index = () => ordered().findIndex((step) => step.id === props.stepId);
  const step = () => ordered()[index()];
  const total = () => ordered().length;
  const title = (at: number) => stepTitle(at, total());
  const day = () =>
    1 +
    ordered()
      .slice(0, index() + 1)
      .reduce((sum, s) => sum + delayMinutesToDays(s.delayMinutes), 0);
  const numbers = () => stats.data?.steps.find((s) => s.stepId === step()?.id);
  const sent = () => numbers()?.sent ?? 0;
  const tracked = () => campaign.data?.settings.trackOpens !== false;
  const from = () => {
    const sender = senders.data?.[0];
    if (!sender) return '';
    if (sender.mailbox.kind !== 'identity') return 'Connected mailbox';
    const identityId = sender.mailbox.identity_id;
    return (
      identities.data?.find((i) => i.id === identityId)?.fromEmail ??
      'Sending identity'
    );
  };

  /** Everyone whose progress went past this email, with what they did next. */
  const got = createMemo(() => {
    const position = index() + 1;
    if (!position) return [];
    return recipients()
      .filter((r) => sentCount(r, total()) >= position)
      .map((recipient) => ({
        recipient,
        outcome: outcomeOf(recipient, position, total()),
      }));
  });
  const [filter, setFilter] = createSignal<Filter>('all');
  const [search, setSearch] = createSignal('');
  const [chosen, setChosen] = createSignal<string>();
  const countOf = (value: Filter) =>
    got().filter((row) => inFilter(value, row.outcome)).length;
  const filters = createMemo(() =>
    FILTERS.filter((f) => f.value === 'all' || countOf(f.value) > 0).map(
      (f) => ({ value: f.value, label: f.label, count: countOf(f.value) })
    )
  );
  const shown = createMemo(() => {
    const query = search().trim().toLowerCase();
    return got().filter(
      (row) =>
        inFilter(filter(), row.outcome) &&
        (!query ||
          `${row.recipient.name ?? ''} ${row.recipient.email}`
            .toLowerCase()
            .includes(query))
    );
  });
  // Another email starts from everyone, with the first person's copy open.
  createEffect(() => {
    props.stepId;
    setFilter('all');
    setChosen(undefined);
  });
  const person = () =>
    got().find((row) => row.recipient.rowId === chosen())?.recipient ??
    shown()[0]?.recipient;

  const subject = () => {
    const s = step();
    if (!s) return '';
    const values = person() ? valuesFor(person()!) : undefined;
    if (s.subject) return fill(s.subject, values);
    const first = ordered()[0]?.subject ?? '';
    return `Re: ${fill(first, values) || '(no subject)'}`;
  };
  const body = () => {
    const s = step();
    if (!s) return '';
    const text = s.bodyText ?? htmlToText(s.bodyHtml);
    return fill(text, person() ? valuesFor(person()!) : undefined);
  };

  return (
    <Show
      when={step()}
      fallback={
        <EmptyStatePanel
          centered
          graphic={EmptyStateEmailGraphic}
          title={
            steps.isPending
              ? 'Loading the email…'
              : 'This email is no longer in the sequence.'
          }
          primaryAction={
            steps.isPending
              ? undefined
              : {
                  label: 'Back to overview',
                  onClick: () => props.onOpenStep(undefined),
                }
          }
        />
      }
    >
      {(current) => (
        <div class="@container/step size-full">
          <div class="flex size-full min-h-0 flex-col @4xl/step:flex-row">
            <div class="min-h-0 min-w-0 flex-1">
              <RecordSection
                title={`People who got ${title(index())}`}
                search={search()}
                onSearchChange={setSearch}
                onSearchEscape={() => setSearch('')}
                searchPlaceholder="Search people…"
                actions={
                  <RecordSectionFilters
                    activeCount={Number(filter() !== 'all')}
                    onClear={() => setFilter('all')}
                  >
                    <Tabs
                      aria-label="What they did next"
                      size="sm"
                      touch="inset"
                      options={filters()}
                      value={filter()}
                      onChange={setFilter}
                    />
                  </RecordSectionFilters>
                }
              >
                <div
                  role="listbox"
                  aria-label={`People who got ${title(index())}`}
                  class="flex min-w-0 flex-col"
                >
                  <div class="sticky top-0 z-10 grid h-8 shrink-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-4 border-b border-edge-muted bg-panel px-3 text-xs text-ink-muted">
                    <span>Name</span>
                    <span>Company</span>
                    <span>After this email</span>
                  </div>
                  <For
                    each={shown()}
                    fallback={
                      <Show
                        when={!recipientsQuery.isPending}
                        fallback={
                          <p class="px-3 py-10 text-center text-sm text-ink-muted">
                            Loading people…
                          </p>
                        }
                      >
                        <EmptyStatePanel
                          centered
                          graphic={
                            got().length
                              ? EmptyStateNoSearchMatchGraphic
                              : EmptyStateEmailGraphic
                          }
                          title={
                            got().length
                              ? 'Nobody matches this search or filter.'
                              : 'This email hasn’t gone to anyone yet.'
                          }
                          primaryAction={
                            got().length
                              ? {
                                  label: 'Show everyone',
                                  onClick: () => {
                                    setSearch('');
                                    setFilter('all');
                                  },
                                }
                              : undefined
                          }
                        />
                      </Show>
                    }
                  >
                    {(row) => (
                      <PersonRow
                        recipient={row.recipient}
                        outcome={row.outcome}
                        next={
                          row.outcome === 'moved'
                            ? `Last got ${title(sentCount(row.recipient, total()) - 1)}`
                            : row.outcome === 'waiting' &&
                                row.recipient.nextSendAt
                              ? `${title(index() + 1)} ${formatRelative(row.recipient.nextSendAt)}`
                              : undefined
                        }
                        selected={person()?.rowId === row.recipient.rowId}
                        onSelect={() => setChosen(row.recipient.rowId)}
                      />
                    )}
                  </For>
                  <Show when={got().length && got().length < sent()}>
                    <p class="px-3 pt-3 text-xs text-ink-muted">
                      Showing the {formatCount(got().length)} people loaded of{' '}
                      {formatCount(sent())} sent.
                    </p>
                  </Show>
                </div>
              </RecordSection>
            </div>

            <aside
              aria-label={`${title(index())} as sent`}
              class="flex max-h-[55%] min-h-0 shrink-0 flex-col overflow-y-auto border-t border-edge-muted @4xl/step:max-h-none @4xl/step:w-[30rem] @4xl/step:border-t-0 @4xl/step:border-l"
            >
              <div class="flex min-h-12 shrink-0 items-center gap-2 px-4 py-2">
                <h2 class="min-w-0 flex-1 truncate text-sm font-medium">
                  {title(index())}
                  <span class="ml-2 font-normal text-ink-muted tabular-nums">
                    Email {index() + 1} of {total()}
                  </span>
                </h2>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => props.onOpenSection('sequence')}
                >
                  <PencilIcon class="size-4" />
                  Edit
                </Button>
              </div>

              <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 pb-4 text-sm">
                <Property label="Sends on">
                  Day {day()}
                  <Show
                    when={
                      current().condition && current().condition !== 'always'
                    }
                  >
                    <span class="text-ink-muted">
                      {' · '}
                      {
                        CONDITION_LABEL[
                          current().condition as keyof typeof CONDITION_LABEL
                        ]
                      }
                    </span>
                  </Show>
                </Property>
                <Property label="Sent">
                  <span class="tabular-nums">
                    {formatCount(sent())} {sent() === 1 ? 'person' : 'people'}
                  </span>
                </Property>
                <Property label="Opened">
                  <Show
                    when={tracked()}
                    fallback={<span class="text-ink-muted">Not tracked</span>}
                  >
                    <Rate value={numbers()?.opened ?? 0} of={sent()} />
                  </Show>
                </Property>
                <Property label="Replied after it">
                  <Rate value={numbers()?.replied ?? 0} of={sent()} />
                </Property>
                <Property label="Bounced">
                  <Rate value={numbers()?.bounced ?? 0} of={sent()} />
                </Property>
              </dl>

              <div class="px-3 pb-4">
                <ComposerSurface as="div" class="flex flex-col gap-3 p-4">
                  <div class="ph-no-capture flex items-center gap-2">
                    <Avatar size="sm" aria-hidden="true">
                      <Avatar.Fallback>
                        {(from() || '?').slice(0, 1).toUpperCase()}
                      </Avatar.Fallback>
                    </Avatar>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">
                      {from() || 'Your mailbox'}
                    </span>
                  </div>
                  <div class="ph-no-capture flex flex-col gap-1 text-xs">
                    <Header label="To">{person()?.email ?? '—'}</Header>
                    <Header label="Subject">
                      <TemplateText text={subject()} />
                    </Header>
                  </div>
                  <p class="ph-no-capture text-sm leading-relaxed whitespace-pre-wrap">
                    <Show when={body()} fallback="This email has no message.">
                      <TemplateText text={body()} />
                    </Show>
                  </p>
                </ComposerSurface>
                <Show when={sent() > 0}>
                  <p class="mt-3 flex items-start gap-2 px-1 text-xs text-ink-muted">
                    <LockIcon class="mt-px size-3.5 shrink-0" />
                    Sent copies can’t change. Edits reach only people who get it
                    from now on, and a sent email can’t be removed.
                  </p>
                </Show>
              </div>
            </aside>
          </div>
        </div>
      )}
    </Show>
  );
}

/** A label-and-value row, like the info panel's metadata. */
function Property(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <dt class="truncate text-ink-muted">{props.label}</dt>
      <dd class="min-w-0 truncate">{props.children}</dd>
    </>
  );
}

function Rate(props: { value: number; of: number }) {
  return (
    <span class="tabular-nums">
      {formatCount(props.value)}
      <span class="ml-1.5 text-ink-muted">
        {formatShare(props.value, props.of)}
      </span>
    </span>
  );
}

/** One header line of the message, as Mail's expanded details show it. */
function Header(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-baseline gap-3">
      <span class="w-12 shrink-0 text-ink-extra-muted">{props.label}</span>
      <span class="min-w-0 truncate text-ink">{props.children}</span>
    </div>
  );
}

function PersonRow(props: {
  recipient: CampaignRecipient;
  outcome: Outcome;
  next?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = () => props.recipient.name || props.recipient.email;
  const outcome = () => OUTCOME[props.outcome];
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
      class={cn(
        'grid h-11 shrink-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-4 rounded-md px-3 text-left text-sm',
        props.selected ? 'bg-hover' : 'not-touch:hover:bg-hover'
      )}
    >
      <span class="flex min-w-0 items-center gap-2.5">
        <Avatar size="sm" aria-hidden="true">
          <Avatar.Fallback>{label().slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar>
        <span class="ph-no-capture flex min-w-0 flex-col">
          <span class="truncate font-medium">{label()}</span>
          <Show when={props.recipient.name}>
            <span class="truncate text-xs text-ink-muted">
              {props.recipient.email}
            </span>
          </Show>
        </span>
      </span>
      <span class="ph-no-capture truncate text-ink-muted">
        {domainOf(props.recipient.email)}
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="flex min-w-0 items-center gap-1.5">
          <span
            class="size-2 shrink-0 rounded-full"
            style={{ background: outcome().fill }}
          />
          <span class="truncate">{outcome().label}</span>
        </span>
        <Show when={props.next}>
          <span class="truncate pl-3.5 text-xs text-ink-muted">
            {props.next}
          </span>
        </Show>
      </span>
    </button>
  );
}
