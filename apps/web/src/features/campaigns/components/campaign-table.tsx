import { MultiSelectCheckbox } from '@entity';
import ArrowDownIcon from '@icon/system/regular/arrow-down.svg';
import CopyIcon from '@icon/system/regular/copy.svg';
import DotsThreeIcon from '@icon/system/regular/dots-three.svg';
import PauseIcon from '@icon/system/regular/pause.svg';
import PlayIcon from '@icon/system/regular/play.svg';
import StackIcon from '@icon/system/regular/stack-simple.svg';
import TrashIcon from '@icon/system/regular/trash.svg';
import XIcon from '@icon/system/regular/x.svg';
import { Button, cn, Dropdown, Tooltip } from '@ui';
import { For, Index, type JSX, Show } from 'solid-js';
import { formatCount, formatShare, STATUS } from '../core/format';
import type { Campaign, CampaignStatus } from '../core/sample';

export type CampaignSortKey =
  | 'recent'
  | 'name'
  | 'progress'
  | 'replies'
  | 'opens'
  | 'bounce';
export type CampaignSort = { key: CampaignSortKey; reversed: boolean };
export type CampaignAction =
  | 'open'
  | 'pause'
  | 'resume'
  | 'launch'
  | 'duplicate'
  | 'delete';

/** Bounces at or above this share pause a campaign by itself. */
export const BOUNCE_LIMIT = 0.05;

const progress = (c: Campaign) => (c.people ? c.sent / c.people : 0);
const bounce = (c: Campaign) => (c.sent ? c.bounced / c.sent : 0);

const SORT_VALUE: Record<
  Exclude<CampaignSortKey, 'recent' | 'name'>,
  (c: Campaign) => number
> = {
  progress,
  replies: (c) => c.replied,
  opens: (c) => (c.sent ? (c.opened ?? 0) / c.sent : 0),
  bounce,
};

/** Highest first for numbers, A–Z for names; `reversed` flips either. */
export function sortCampaigns(campaigns: Campaign[], sort: CampaignSort) {
  if (sort.key === 'recent')
    return sort.reversed ? [...campaigns].reverse() : campaigns;
  const direction = sort.reversed ? -1 : 1;
  if (sort.key === 'name')
    return [...campaigns].sort(
      (a, b) => a.name.localeCompare(b.name) * direction
    );
  const value = SORT_VALUE[sort.key];
  return [...campaigns].sort((a, b) => (value(b) - value(a)) * direction);
}

// One grid for the header and every row so the columns line up. Columns
// appear by priority as the panel widens.
const COLUMNS =
  'grid items-center gap-x-4 grid-cols-[2rem_minmax(0,1fr)_7rem_2rem] @3xl/campaigns:grid-cols-[2rem_minmax(0,1fr)_7rem_10rem_6.5rem_2rem] @5xl/campaigns:grid-cols-[2rem_minmax(0,1fr)_7rem_11rem_6.5rem_4.5rem_4.5rem_5.5rem_2rem]';
const MID = 'hidden @3xl/campaigns:flex';
const WIDE = 'hidden @5xl/campaigns:flex';

function SortHeader(props: {
  label: string;
  key: CampaignSortKey;
  sort: CampaignSort;
  onSort: (key: CampaignSortKey) => void;
  class?: string;
  align?: 'end';
}) {
  const active = () => props.sort.key === props.key;
  return (
    <span
      role="columnheader"
      aria-sort={
        active() ? (props.sort.reversed ? 'ascending' : 'descending') : 'none'
      }
      class={cn('flex min-w-0', props.align && 'justify-end', props.class)}
    >
      <button
        type="button"
        onClick={() => props.onSort(props.key)}
        class={cn(
          'flex min-w-0 items-center gap-1 rounded transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
          active() && 'text-ink'
        )}
      >
        <span class="truncate">{props.label}</span>
        <ArrowDownIcon
          class={cn(
            'size-3 shrink-0 transition-transform',
            active() ? 'opacity-100' : 'opacity-0',
            active() && props.sort.reversed && 'rotate-180'
          )}
        />
      </button>
    </span>
  );
}

function DailyBars(props: { campaign: Campaign }) {
  const values = () => props.campaign.daily;
  const peak = () => Math.max(1, ...values());
  const total = () => values().reduce((a, b) => a + b, 0);
  const idle = () => total() === 0 && STATUS[props.campaign.status].idle;
  return (
    <Show
      when={!idle()}
      fallback={
        <span class="truncate text-xs text-ink-extra-muted">{idle()}</span>
      }
    >
      <Tooltip label={`${formatCount(total())} sent in the last 14 days`}>
        <span
          role="img"
          aria-label={`${formatCount(total())} sent in the last 14 days`}
          class="flex h-5 items-end gap-[2px]"
        >
          <Index each={values()}>
            {(value, index) => (
              <span
                class={cn(
                  'w-[3px] shrink-0 rounded-[1px]',
                  value() === 0
                    ? 'bg-edge'
                    : index === values().length - 1
                      ? 'bg-accent'
                      : 'bg-ink-extra-muted/45'
                )}
                style={{
                  height:
                    value() > 0
                      ? `${Math.max(3, (value() / peak()) * 20)}px`
                      : '2px',
                }}
              />
            )}
          </Index>
        </span>
      </Tooltip>
    </Show>
  );
}

function RowMenu(props: {
  campaign: Campaign;
  onAction: (action: CampaignAction) => void;
}) {
  const status = () => props.campaign.status;
  return (
    <span
      class="flex justify-end"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dropdown>
        <Dropdown.Trigger
          as={Button}
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${props.campaign.name}`}
          class="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-expanded:opacity-100 touch:opacity-100"
        >
          <DotsThreeIcon class="size-4" />
        </Dropdown.Trigger>
        <Dropdown.Content class="min-w-44">
          <Dropdown.Group>
            <Dropdown.Item onSelect={() => props.onAction('open')}>
              <StackIcon class="size-4 text-ink-muted" />
              Open
            </Dropdown.Item>
            <Show when={status() === 'active'}>
              <Dropdown.Item onSelect={() => props.onAction('pause')}>
                <PauseIcon class="size-4 text-ink-muted" />
                Pause
              </Dropdown.Item>
            </Show>
            <Show when={status() === 'paused'}>
              <Dropdown.Item onSelect={() => props.onAction('resume')}>
                <PlayIcon class="size-4 text-ink-muted" />
                Resume
              </Dropdown.Item>
            </Show>
            <Show when={status() === 'draft'}>
              <Dropdown.Item onSelect={() => props.onAction('launch')}>
                <PlayIcon class="size-4 text-ink-muted" />
                Launch
              </Dropdown.Item>
            </Show>
            <Dropdown.Item onSelect={() => props.onAction('duplicate')}>
              <CopyIcon class="size-4 text-ink-muted" />
              Duplicate
            </Dropdown.Item>
          </Dropdown.Group>
          <Dropdown.Separator class="my-1 border-t border-edge-divider" />
          <Dropdown.Group>
            <Dropdown.Item
              class="text-failure"
              onSelect={() => props.onAction('delete')}
            >
              <TrashIcon class="size-4" />
              Delete
            </Dropdown.Item>
          </Dropdown.Group>
        </Dropdown.Content>
      </Dropdown>
    </span>
  );
}

const STATUS_PILL: Record<CampaignStatus, string> = {
  active: 'bg-success/10 text-success',
  paused: 'bg-warning/10 text-warning',
  draft: 'bg-hover text-ink-muted',
  completed: 'bg-accent/10 text-accent',
};

const MONOGRAM = [
  'bg-accent/12 text-accent',
  'bg-purple/12 text-purple',
  'bg-success/12 text-success',
  'bg-warning/12 text-warning',
  'bg-failure/10 text-failure',
];

/** A steady colour per campaign name, so a row is findable at a glance. */
function Monogram(props: { name: string }) {
  const tone = () => {
    let hash = 0;
    for (const char of props.name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return MONOGRAM[Math.abs(hash) % MONOGRAM.length];
  };
  const letters = () =>
    props.name
      .split(/\s+/)
      .filter((word) => /\w/.test(word))
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('');
  return (
    <span
      aria-hidden="true"
      class={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold',
        tone()
      )}
    >
      {letters()}
    </span>
  );
}

function StatusPill(props: { status: CampaignStatus }) {
  return (
    <span
      class={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium',
        STATUS_PILL[props.status]
      )}
    >
      <span class="relative flex size-1.5">
        <Show when={props.status === 'active'}>
          <span class="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />
        </Show>
        <span class="relative size-1.5 rounded-full bg-current" />
      </span>
      {STATUS[props.status].label}
    </span>
  );
}

/** Everyone enrolled: who replied, bounced, was contacted, or is still to go. */
function ProgressBar(props: { campaign: Campaign }) {
  const c = () => props.campaign;
  const part = (n: number) => `${(n / Math.max(1, c().people)) * 100}%`;
  return (
    <Tooltip
      label={`${formatCount(c().sent)} of ${formatCount(c().people)} contacted · ${formatCount(c().replied)} replied · ${formatCount(c().bounced)} bounced`}
      class="flex w-full min-w-0 flex-1 flex-col gap-1"
    >
      <span class="flex h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <span
          class="rounded-full bg-accent"
          style={{ width: part(Math.min(c().sent, c().people)) }}
        />
      </span>
      <span class="flex w-full justify-between gap-2 text-[11px] text-ink-extra-muted tabular-nums">
        <span>
          {formatCount(Math.min(c().sent, c().people))} /{' '}
          {formatCount(c().people)}
        </span>
        <span>{formatShare(Math.min(c().sent, c().people), c().people)}</span>
      </span>
    </Tooltip>
  );
}

/** A rate as a tinted chip: green when it is good, red when it hurts. */
function RateChip(props: { part: number; whole: number; tone: string }) {
  return (
    <span
      class={cn(
        'inline-flex h-5 min-w-12 items-center justify-center rounded-md px-1.5 text-xs font-medium',
        props.whole ? props.tone : 'text-ink-extra-muted'
      )}
    >
      {formatShare(props.part, props.whole)}
    </span>
  );
}

const replyTone = (c: Campaign) => {
  const rate = c.sent ? c.replied / c.sent : 0;
  return rate >= 0.1
    ? 'bg-success/15 text-success'
    : rate >= 0.04
      ? 'bg-success/8 text-success'
      : 'bg-hover text-ink-muted';
};
const bounceTone = (c: Campaign) => {
  const rate = bounce(c);
  return rate >= BOUNCE_LIMIT
    ? 'bg-failure/12 text-failure'
    : rate >= 0.02
      ? 'bg-warning/12 text-warning'
      : 'bg-hover text-ink-muted';
};

function Cell(props: { class?: string; children: JSX.Element }) {
  return (
    <span
      role="cell"
      class={cn('min-w-0 items-center text-sm tabular-nums', props.class)}
    >
      {props.children}
    </span>
  );
}

/**
 * Campaigns as a list, laid out like Customers: one line per campaign,
 * sortable columns, hover selection for bulk actions and a row menu.
 */
export function CampaignTable(props: {
  campaigns: Campaign[];
  sort: CampaignSort;
  onSort: (key: CampaignSortKey) => void;
  selected: ReadonlySet<string>;
  onSelectedChange: (ids: Set<string>) => void;
  onOpen: (id: string) => void;
  onAction: (ids: string[], action: CampaignAction) => void;
}) {
  const rows = () => props.campaigns;
  const allSelected = () =>
    rows().length > 0 &&
    rows().every((campaign) => props.selected.has(campaign.id));
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(props.selected);
    if (checked) next.add(id);
    else next.delete(id);
    props.onSelectedChange(next);
  };
  const selectedIds = () => [...props.selected];
  const selectedCampaigns = () =>
    props.campaigns.filter((campaign) => props.selected.has(campaign.id));
  const bulk = (action: CampaignAction) => {
    props.onAction(selectedIds(), action);
    if (action === 'delete') props.onSelectedChange(new Set());
  };

  return (
    <div role="table" aria-label="Campaigns" class="flex min-w-0 flex-col">
      <div
        role="row"
        class={cn(
          COLUMNS,
          'sticky top-0 z-[1] h-10 bg-surface px-4 text-xs font-medium text-ink-extra-muted'
        )}
      >
        <span
          role="columnheader"
          class="flex size-8 items-center justify-center"
        >
          <MultiSelectCheckbox
            checked={allSelected()}
            showBorder={props.selected.size > 0}
            onChecked={(checked) =>
              props.onSelectedChange(
                new Set(checked ? rows().map((campaign) => campaign.id) : [])
              )
            }
          />
        </span>
        <Show
          when={props.selected.size === 0}
          fallback={
            <span
              role="columnheader"
              class="col-span-full col-start-2 flex min-w-0 items-center gap-1 text-ink"
            >
              <span class="mr-2 shrink-0 text-sm font-medium tabular-nums">
                {props.selected.size} selected
              </span>
              <Show
                when={selectedCampaigns().some((c) => c.status === 'active')}
              >
                <Button variant="ghost" size="sm" onClick={() => bulk('pause')}>
                  <PauseIcon class="size-4" />
                  Pause
                </Button>
              </Show>
              <Show
                when={selectedCampaigns().some((c) => c.status === 'paused')}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => bulk('resume')}
                >
                  <PlayIcon class="size-4" />
                  Resume
                </Button>
              </Show>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => bulk('duplicate')}
              >
                <CopyIcon class="size-4" />
                Duplicate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-failure"
                onClick={() => bulk('delete')}
              >
                <TrashIcon class="size-4" />
                Delete
              </Button>
              <Tooltip label="Clear selection" class="ml-auto">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear selection"
                  onClick={() => props.onSelectedChange(new Set())}
                >
                  <XIcon class="size-4" />
                </Button>
              </Tooltip>
            </span>
          }
        >
          <SortHeader
            label="Campaign"
            key="name"
            sort={props.sort}
            onSort={props.onSort}
          />
          <span role="columnheader">Status</span>
          <SortHeader
            label="Progress"
            key="progress"
            sort={props.sort}
            onSort={props.onSort}
            class={MID}
          />
          <SortHeader
            label="Replies"
            key="replies"
            sort={props.sort}
            onSort={props.onSort}
            class={MID}
            align="end"
          />
          <SortHeader
            label="Opened"
            key="opens"
            sort={props.sort}
            onSort={props.onSort}
            class={WIDE}
            align="end"
          />
          <SortHeader
            label="Bounced"
            key="bounce"
            sort={props.sort}
            onSort={props.onSort}
            class={WIDE}
            align="end"
          />
          <span role="columnheader" class={cn('justify-end', WIDE)}>
            Last 14 days
          </span>
          <span aria-hidden="true" />
        </Show>
      </div>
      <div class="flex flex-col">
        <For each={rows()}>
          {(campaign) => {
            const checked = () => props.selected.has(campaign.id);
            return (
              <div
                role="row"
                tabindex={0}
                aria-selected={checked()}
                class={cn(
                  COLUMNS,
                  'group/row min-h-14 cursor-default rounded-xl px-4 outline-none focus-visible:bg-list-highlighted',
                  checked()
                    ? 'bg-list-selected'
                    : 'not-touch:hover:bg-list-hover'
                )}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey)
                    toggle(campaign.id, !checked());
                  else props.onOpen(campaign.id);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter') props.onOpen(campaign.id);
                  if (event.key === ' ') {
                    event.preventDefault();
                    toggle(campaign.id, !checked());
                  }
                }}
              >
                <span
                  role="cell"
                  class="relative flex size-8 items-center justify-center"
                >
                  <span
                    class={cn(
                      'flex',
                      checked() || props.selected.size > 0
                        ? 'invisible'
                        : 'not-touch:group-hover/row:invisible'
                    )}
                  >
                    <Monogram name={campaign.name} />
                  </span>
                  <span
                    class={cn(
                      'absolute inset-0 flex items-center justify-center',
                      checked() || props.selected.size > 0
                        ? 'visible'
                        : 'invisible not-touch:group-hover/row:visible'
                    )}
                  >
                    <MultiSelectCheckbox
                      checked={checked()}
                      showBorder
                      onChecked={(value) => toggle(campaign.id, value)}
                    />
                  </span>
                </span>
                <Cell class="flex">
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-medium text-ink">
                      {campaign.name}
                    </span>
                    <span class="truncate text-xs text-ink-extra-muted">
                      {[
                        campaign.people
                          ? `${formatCount(campaign.people)} people`
                          : 'No people yet',
                        campaign.window,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </Cell>
                <Cell class="flex">
                  <StatusPill status={campaign.status} />
                </Cell>
                <Cell class={cn('gap-2', MID)}>
                  <Show
                    when={campaign.people > 0}
                    fallback={
                      <span class="text-xs text-ink-extra-muted">
                        Add people to start
                      </span>
                    }
                  >
                    <ProgressBar campaign={campaign} />
                  </Show>
                </Cell>
                <Cell class={cn('justify-end gap-2', MID)}>
                  <span class="text-ink">{formatCount(campaign.replied)}</span>
                  <RateChip
                    part={campaign.replied}
                    whole={campaign.sent}
                    tone={replyTone(campaign)}
                  />
                </Cell>
                <Cell class={cn('justify-end text-ink', WIDE)}>
                  {campaign.sent && campaign.opened
                    ? formatShare(campaign.opened, campaign.sent)
                    : '—'}
                </Cell>
                <Cell class={cn('justify-end', WIDE)}>
                  <RateChip
                    part={campaign.bounced}
                    whole={campaign.sent}
                    tone={bounceTone(campaign)}
                  />
                </Cell>
                <Cell class={cn('justify-end', WIDE)}>
                  <DailyBars campaign={campaign} />
                </Cell>
                <RowMenu
                  campaign={campaign}
                  onAction={(action) => props.onAction([campaign.id], action)}
                />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
