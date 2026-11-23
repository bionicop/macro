import {
  RecordSection,
  RecordSectionFilters,
} from '@app/features/crm/components/record-section';
import { toast } from '@core/component/Toast/Toast';
import EmptyStateEmailGraphic from '@design/empty-state-email.svg';
import EmptyStateNoSearchMatchGraphic from '@design/empty-state-no-search-match.svg';
import BuildingsIcon from '@icon/system/regular/buildings.svg';
import PlusIcon from '@icon/system/regular/plus.svg';
import XIcon from '@icon/system/regular/x.svg';
import type {
  CampaignRecipient,
  CampaignRecipientState,
  CampaignStep,
} from '@service-storage/campaigns';
import { Avatar, Button, Checkbox, cn, EmptyStatePanel, Tabs } from '@ui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  Show,
} from 'solid-js';
import { AddPeopleDialog } from '../components/people-input';
import { TemplateText } from '../components/template-text';
import {
  formatCount,
  formatRelative,
  RECIPIENT_STATE,
  stepTitle,
} from '../core/format';
import {
  domainOf,
  fill,
  type StepMark,
  sentCount,
  stepMarks,
  valuesFor,
} from '../core/recipients';
import type { Campaign } from '../core/sample';
import {
  useCampaignRecipientsQuery,
  useCampaignRowCountQuery,
  useCampaignStepsQuery,
  useRemoveCampaignRecipients,
} from '../queries';

/** Everyone enrolled is loaded so search and filters see the whole list. */
const LOAD_LIMIT = 5000;

/** Name, company, status, progress, next email: one line per person. */
const COLUMNS =
  'grid grid-cols-[1rem_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_9rem] items-center gap-3 px-2';
/** With a person open beside the list, company and next step give way. */
const COMPACT =
  'grid grid-cols-[1rem_minmax(0,2fr)_minmax(0,1fr)_6rem] items-center gap-3 px-2';

/** Filter tabs, each a group of states; empty groups are hidden. */
const FILTERS = [
  { value: 'all', label: 'Everyone', states: [] },
  { value: 'active', label: 'In sequence', states: ['active'] },
  { value: 'replied', label: 'Replied', states: ['replied'] },
  { value: 'completed', label: 'Finished', states: ['completed'] },
  { value: 'bounced', label: 'Bounced', states: ['bounced', 'failed'] },
  { value: 'stopped', label: 'Stopped', states: ['unsubscribed', 'removed'] },
] as const satisfies readonly {
  value: string;
  label: string;
  states: readonly CampaignRecipientState[];
}[];
type Filter = (typeof FILTERS)[number]['value'];

const inFilter = (filter: Filter, state: CampaignRecipientState) =>
  filter === 'all' ||
  (
    FILTERS.find((f) => f.value === filter)?.states as
      | readonly CampaignRecipientState[]
      | undefined
  )?.includes(state) === true;

const MARK: Record<StepMark, { label: string; fill: string }> = {
  sent: { label: 'Sent', fill: 'var(--color-ink-muted)' },
  next: { label: 'Next', fill: 'var(--color-accent)' },
  later: { label: 'Later', fill: 'var(--color-edge-muted)' },
  skipped: { label: 'Won’t send', fill: 'var(--color-edge-muted)' },
};

/**
 * Everyone in the campaign, tracked like the CRM's People list: one line per
 * person with where they are in the sequence. Choosing someone opens what
 * they got and what comes next; an email there opens its report.
 */
export function CampaignPeople(props: {
  campaign: Campaign;
  onOpenStep: (stepId: string) => void;
}) {
  const id = () => props.campaign.id;
  const recipientsQuery = useCampaignRecipientsQuery(id);
  const steps = useCampaignStepsQuery(id);
  const remove = useRemoveCampaignRecipients();
  // Before launch people are only rows of the list; count those.
  const rows = useCampaignRowCountQuery(id);
  const draft = () => props.campaign.status === 'draft';
  const listed = () => rows.data?.count ?? 0;
  const [adding, setAdding] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [filter, setFilter] = createSignal<Filter>('all');
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = createSignal<string>();

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
  const total = () => ordered().length;

  const countOf = (value: Filter) =>
    recipients().filter((r) => inFilter(value, r.state)).length;
  const filters = createMemo(() =>
    FILTERS.filter((f) => f.value === 'all' || countOf(f.value) > 0).map(
      (f) => ({ value: f.value, label: f.label, count: countOf(f.value) })
    )
  );
  const shown = createMemo(() => {
    const query = search().trim().toLowerCase();
    return recipients().filter(
      (recipient) =>
        inFilter(filter(), recipient.state) &&
        (!query ||
          `${recipient.name ?? ''} ${recipient.email}`
            .toLowerCase()
            .includes(query))
    );
  });
  const person = () => recipients().find((r) => r.rowId === chosen());

  // Selection only ever covers rows the current view shows.
  const visibleSelected = createMemo(() =>
    shown().filter((recipient) => selected().has(recipient.rowId))
  );
  const allSelected = () =>
    shown().length > 0 && visibleSelected().length === shown().length;
  const toggle = (rowId: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(rowId);
    else next.delete(rowId);
    setSelected(next);
  };
  const toggleAll = (on: boolean) =>
    setSelected(
      on ? new Set(shown().map((recipient) => recipient.rowId)) : new Set<string>()
    );
  const removable = () =>
    visibleSelected().filter((recipient) => recipient.state === 'active');
  const removeRows = (rowIds: string[]) => {
    if (!rowIds.length) return;
    remove.mutate(
      { id: id(), rowIds },
      {
        onSuccess: (result) => {
          setSelected(new Set<string>());
          toast.success(
            `Stopped the sequence for ${formatCount(result.removed)} ${result.removed === 1 ? 'person' : 'people'}`
          );
        },
        onError: () => toast.failure('Couldn’t remove them. Try again.'),
      }
    );
  };

  return (
    <div class="@container/people size-full">
      <div class="flex size-full min-h-0 flex-col @4xl/people:flex-row">
        <div class="min-h-0 min-w-0 flex-1">
          <RecordSection
            title="People"
            search={search()}
            onSearchChange={setSearch}
            onSearchEscape={() => setSearch('')}
            searchPlaceholder="Search people…"
            actions={
              <>
                <Show when={recipients().length}>
                  <RecordSectionFilters
                    activeCount={Number(filter() !== 'all')}
                    onClear={() => setFilter('all')}
                  >
                    <Tabs
                      aria-label="Where they are"
                      size="sm"
                      touch="inset"
                      options={filters()}
                      value={filter()}
                      onChange={setFilter}
                    />
                  </RecordSectionFilters>
                </Show>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setAdding(true)}
                >
                  <PlusIcon class="size-4" />
                  Add people
                </Button>
              </>
            }
          >
            <AddPeopleDialog
              campaignId={id()}
              open={adding()}
              existing={listed()}
              onClose={() => setAdding(false)}
            />
            <Show when={draft() && listed()}>
              <p class="px-2 pb-2 text-xs text-ink-muted tabular-nums">
                {formatCount(listed())}
                {rows.data?.more ? '+' : ''}{' '}
                {listed() === 1 ? 'person is' : 'people are'} on the list. They
                start the sequence when you launch.
              </p>
            </Show>

            <Show when={visibleSelected().length}>
              <div
                role="toolbar"
                aria-label="Selected people"
                class="mb-1 flex h-9 items-center gap-3 rounded-md bg-hover px-2 text-sm"
              >
                <span class="tabular-nums">
                  {formatCount(visibleSelected().length)} selected
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!removable().length || remove.isPending}
                  tooltip={
                    removable().length
                      ? undefined
                      : 'Only people still in the sequence can be removed'
                  }
                  onClick={() => removeRows(removable().map((r) => r.rowId))}
                >
                  Remove from campaign
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="ml-auto"
                  aria-label="Clear selection"
                  onClick={() => setSelected(new Set<string>())}
                >
                  <XIcon class="size-4" />
                </Button>
              </div>
            </Show>

            <div
              role="listbox"
              aria-label="People in this campaign"
              class="flex min-w-0 flex-col"
            >
              <Show when={recipients().length}>
                <div
                  class={`${person() ? COMPACT : COLUMNS} sticky top-0 z-10 h-8 shrink-0 border-b border-edge-muted bg-panel text-xs text-ink-muted`}
                >
                  <span class="flex items-center">
                    <Checkbox
                      checked={allSelected()}
                      indeterminate={
                        visibleSelected().length > 0 && !allSelected()
                      }
                      disabled={!shown().length}
                      onChange={toggleAll}
                    >
                      <Checkbox.Control />
                      <Checkbox.Label class="sr-only">
                        Select everyone shown
                      </Checkbox.Label>
                    </Checkbox>
                  </span>
                  <span>Name</span>
                  <Show when={!person()}>
                    <span>Company</span>
                  </Show>
                  <span>Status</span>
                  <span>Emails</span>
                  <Show when={!person()}>
                    <span class="text-right">Next</span>
                  </Show>
                </div>
              </Show>
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
                        recipients().length
                          ? EmptyStateNoSearchMatchGraphic
                          : EmptyStateEmailGraphic
                      }
                      title={
                        recipientsQuery.isError
                          ? 'Couldn’t load the people in this campaign.'
                          : recipients().length
                            ? 'Nobody matches this search or filter.'
                            : draft() && listed()
                              ? 'People join the sequence when you launch.'
                              : 'Nobody here yet.'
                      }
                      primaryAction={
                        recipients().length
                          ? {
                              label: 'Show everyone',
                              onClick: () => {
                                setSearch('');
                                setFilter('all');
                              },
                            }
                          : recipientsQuery.isError
                            ? undefined
                            : {
                                label: 'Add people',
                                onClick: () => setAdding(true),
                              }
                      }
                    />
                  </Show>
                }
              >
                {(recipient) => (
                  <PersonRow
                    recipient={recipient}
                    total={total()}
                    compact={!!person()}
                    nextTitle={
                      sentCount(recipient, total()) < total()
                        ? stepTitle(sentCount(recipient, total()), total())
                        : undefined
                    }
                    open={chosen() === recipient.rowId}
                    checked={selected().has(recipient.rowId)}
                    onCheck={(on) => toggle(recipient.rowId, on)}
                    onOpen={() =>
                      setChosen(
                        chosen() === recipient.rowId
                          ? undefined
                          : recipient.rowId
                      )
                    }
                  />
                )}
              </For>
              <Show when={recipientsQuery.isFetchingNextPage}>
                <p class="px-2 pt-2 text-xs text-ink-muted tabular-nums">
                  Loading more… {formatCount(recipients().length)} so far
                </p>
              </Show>
            </div>
          </RecordSection>
        </div>

        <Show when={person()}>
          {(current) => (
            <PersonPanel
              recipient={current()}
              steps={ordered()}
              removing={remove.isPending}
              onClose={() => setChosen(undefined)}
              onOpenStep={props.onOpenStep}
              onRemove={() => removeRows([current().rowId])}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

function PersonRow(props: {
  recipient: CampaignRecipient;
  total: number;
  nextTitle?: string;
  compact: boolean;
  open: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onOpen: () => void;
}) {
  const state = () => RECIPIENT_STATE[props.recipient.state];
  const sent = () => sentCount(props.recipient, props.total);
  const label = () => props.recipient.name || props.recipient.email;
  return (
    <div
      role="option"
      aria-selected={props.open}
      onClick={props.onOpen}
      class={cn(
        props.compact ? COMPACT : COLUMNS,
        'group h-9 shrink-0 cursor-default rounded-md text-sm',
        props.open || props.checked ? 'bg-hover' : 'not-touch:hover:bg-hover'
      )}
    >
      <span
        class={cn(
          'flex items-center opacity-0 group-hover:opacity-100',
          props.checked && 'opacity-100'
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox checked={props.checked} onChange={props.onCheck}>
          <Checkbox.Control />
          <Checkbox.Label class="sr-only">Select {label()}</Checkbox.Label>
        </Checkbox>
      </span>
      <button
        type="button"
        class="ph-no-capture flex min-w-0 items-center gap-2 text-left"
        onClick={(event) => {
          event.stopPropagation();
          props.onOpen();
        }}
      >
        <Avatar size="sm" aria-hidden="true">
          <Avatar.Fallback>{label().slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar>
        <span class="truncate font-medium">{label()}</span>
        <Show when={props.recipient.name}>
          <span class="min-w-0 shrink-[2] truncate text-xs text-ink-extra-muted">
            {props.recipient.email}
          </span>
        </Show>
      </button>
      <Show when={!props.compact}>
        <span class="ph-no-capture flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
          <BuildingsIcon class="size-3.5 shrink-0 text-ink-extra-muted" />
          <span class="truncate">{domainOf(props.recipient.email)}</span>
        </span>
      </Show>
      <span class="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          class="size-2 shrink-0 rounded-full"
          style={{ background: state().fill }}
        />
        <span class="truncate">{state().label}</span>
      </span>
      <span
        class="flex min-w-0 items-center gap-1.5"
        title={`${sent()} of ${props.total} emails sent`}
      >
        <span class="flex shrink-0 gap-0.5" aria-hidden="true">
          <Index each={Array.from({ length: props.total })}>
            {(_, index) => (
              <span
                class="h-1.5 w-2.5 rounded-full"
                style={{
                  background:
                    index < sent()
                      ? 'var(--color-ink-muted)'
                      : 'var(--color-edge-muted)',
                }}
              />
            )}
          </Index>
        </span>
        <span class="text-xs text-ink-muted tabular-nums">
          {sent()}/{props.total}
        </span>
      </span>
      <Show when={!props.compact}>
        <span class="truncate text-right text-xs font-light text-ink-extra-muted tabular-nums">
          {props.recipient.state !== 'active' || !props.nextTitle
            ? '—'
            : props.recipient.nextSendAt
              ? `${props.nextTitle} ${formatRelative(props.recipient.nextSendAt)}`
              : props.nextTitle}
        </span>
      </Show>
    </div>
  );
}

/** One person: where they stand, and each email as sent to them or coming. */
function PersonPanel(props: {
  recipient: CampaignRecipient;
  steps: CampaignStep[];
  removing: boolean;
  onClose: () => void;
  onOpenStep: (stepId: string) => void;
  onRemove: () => void;
}) {
  const label = () => props.recipient.name || props.recipient.email;
  const state = () => RECIPIENT_STATE[props.recipient.state];
  const marks = () => stepMarks(props.recipient, props.steps.length);
  const values = () => valuesFor(props.recipient);
  const subjectOf = (step: CampaignStep) =>
    step.subject
      ? fill(step.subject, values())
      : `Re: ${fill(props.steps[0]?.subject ?? '', values()) || '(no subject)'}`;

  return (
    <aside
      aria-label={label()}
      class="flex max-h-[55%] min-h-0 shrink-0 flex-col overflow-y-auto border-t border-edge-muted @4xl/people:max-h-none @4xl/people:w-[26rem] @4xl/people:border-t-0 @4xl/people:border-l"
    >
      <div class="flex min-h-12 shrink-0 items-center gap-2.5 px-4 py-2">
        <Avatar size="md" aria-hidden="true">
          <Avatar.Fallback>{label().slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar>
        <div class="ph-no-capture flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium">{label()}</span>
          <Show when={props.recipient.name}>
            <span class="truncate text-xs text-ink-muted">
              {props.recipient.email}
            </span>
          </Show>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={props.onClose}
        >
          <XIcon class="size-4" />
        </Button>
      </div>

      <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 pb-4 text-sm">
        <Property label="Status">
          <span class="inline-flex items-center gap-1.5">
            <span
              class="size-2 shrink-0 rounded-full"
              style={{ background: state().fill }}
            />
            {state().label}
          </span>
        </Property>
        <Property label="Company">{domainOf(props.recipient.email)}</Property>
        <Property label="Joined">
          {formatRelative(props.recipient.enrolledAt)}
        </Property>
        <Show
          when={
            props.recipient.state === 'active' && props.recipient.nextSendAt
          }
        >
          {(at) => (
            <Property label="Next email">{formatRelative(at())}</Property>
          )}
        </Show>
        <Show when={props.recipient.timeZone}>
          {(zone) => <Property label="Time zone">{zone()}</Property>}
        </Show>
      </dl>

      <h3 class="px-4 pb-1 text-xs text-ink-muted">Emails</h3>
      <ol class="flex flex-col px-2 pb-3">
        <For each={props.steps}>
          {(step, at) => {
            const mark = () => MARK[marks()[at()] ?? 'later'];
            const done = () => marks()[at()] === 'sent';
            return (
              <li>
                <button
                  type="button"
                  disabled={!done()}
                  onClick={() => props.onOpenStep(step.id)}
                  class={cn(
                    'flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left',
                    done() ? 'not-touch:hover:bg-hover' : 'cursor-default'
                  )}
                >
                  <span
                    class="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ background: mark().fill }}
                  />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="flex items-baseline gap-2 text-sm">
                      <span
                        class={cn(
                          'truncate',
                          done() ? 'font-medium' : 'text-ink-muted'
                        )}
                      >
                        {stepTitle(at(), props.steps.length)}
                      </span>
                      <span class="ml-auto shrink-0 text-xs text-ink-extra-muted">
                        {marks()[at()] === 'next' && props.recipient.nextSendAt
                          ? formatRelative(props.recipient.nextSendAt)
                          : mark().label}
                      </span>
                    </span>
                    <span class="ph-no-capture truncate text-xs text-ink-muted">
                      <TemplateText text={subjectOf(step)} />
                    </span>
                  </span>
                </button>
              </li>
            );
          }}
        </For>
      </ol>

      <Show when={props.recipient.state === 'active'}>
        <div class="mt-auto border-t border-edge-muted px-4 py-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={props.removing}
            onClick={props.onRemove}
          >
            Remove from campaign
          </Button>
        </div>
      </Show>
    </aside>
  );
}

/** A label-and-value row, like the info panel's metadata. */
function Property(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <dt class="truncate text-ink-muted">{props.label}</dt>
      <dd class="ph-no-capture min-w-0 truncate">{props.children}</dd>
    </>
  );
}
