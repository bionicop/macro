import { CanvasZoomToolbar } from '@app/features/block-canvas/views/canvas-toolbars';
import { ComposeFieldRow } from '@app/features/email-compose/components/compose-field-row';
import { SelectInput } from '@app/features/scheduling/components/fields';
import ReplyIcon from '@icon/system/regular/arrow-bend-up-left.svg';
import ArrowDownIcon from '@icon/system/regular/arrow-down.svg';
import EnterIcon from '@icon/system/regular/arrow-square-in.svg';
import ArrowUpIcon from '@icon/system/regular/arrow-up.svg';
import BracketsIcon from '@icon/system/regular/brackets-curly.svg';
import CheckCircleIcon from '@icon/system/regular/check-circle.svg';
import ClockIcon from '@icon/system/regular/clock.svg';
import CopyIcon from '@icon/system/regular/copy.svg';
import EnvelopeIcon from '@icon/system/regular/envelope-simple.svg';
import EyeIcon from '@icon/system/regular/eye.svg';
import EyeSlashIcon from '@icon/system/regular/eye-slash.svg';
import FlagIcon from '@icon/system/regular/flag.svg';
import LockIcon from '@icon/system/regular/lock.svg';
import PaperPlaneTiltIcon from '@icon/system/regular/paper-plane-tilt.svg';
import PlusIcon from '@icon/system/regular/plus.svg';
import SparkleIcon from '@icon/system/regular/sparkle.svg';
import TrashIcon from '@icon/system/regular/trash.svg';
import WarningIcon from '@icon/system/regular/warning-circle.svg';
import XIcon from '@icon/system/regular/x.svg';
import { Popover } from '@kobalte/core/popover';
import type { CampaignStepCondition } from '@service-storage/campaigns';
import { Button, cn, NumberUnitInput, Tabs, ToggleSwitch } from '@ui';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import {
  type CheckLevel,
  checkEmail,
  fillFields,
  MERGE_FIELDS,
  SAMPLE_PERSON,
} from '../core/email-checks';
import { formatCount, formatShare, stepTitle } from '../core/format';

/** One email in the sequence, in the shape the canvas draws. */
export type SequenceNode = {
  id: string;
  /** Days after the previous email; the first email has 0. */
  delayDays: number;
  /** Empty means the email replies in the first email's thread. */
  subject: string;
  body: string;
  /** Who still in the sequence gets it; the first email always goes. */
  condition: CampaignStepCondition;
  sent: number;
  opened: number;
  replied: number;
  /** False until the step has been saved and has a server id. */
  saved: boolean;
};

/** What happens when someone replies, edited on the canvas's last node. */
export type ReplyRules = {
  stopOnReply: boolean;
  autoDraftReplies: boolean;
  trackOpens: boolean;
};

export const FOLLOW_UP_WAIT_DAYS = 3;
export const MAX_WAIT_DAYS = 60;
/** The campaign service accepts at most 20 steps. */
export const MAX_EMAILS = 20;

const STEP_DRAG_TYPE = 'application/x-macro-campaign-step';
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

export const blankEmail = (delayDays: number): SequenceNode => ({
  id: `new-${crypto.randomUUID()}`,
  delayDays,
  subject: '',
  body: '',
  condition: 'always',
  sent: 0,
  opened: 0,
  replied: 0,
  saved: false,
});

const KINDS: {
  condition: CampaignStepCondition;
  label: string;
  icon: typeof EnvelopeIcon;
  tone: string;
  needsOpens?: boolean;
}[] = [
  {
    condition: 'always',
    label: 'Everyone who hasn’t replied',
    icon: EnvelopeIcon,
    tone: 'text-accent bg-accent/10',
  },
  {
    condition: 'not_opened',
    label: 'Only people who didn’t open the last email',
    icon: EyeSlashIcon,
    tone: 'text-warning bg-warning/10',
    needsOpens: true,
  },
  {
    condition: 'opened',
    label: 'Only people who opened it but didn’t reply',
    icon: EyeIcon,
    tone: 'text-purple bg-purple/10',
    needsOpens: true,
  },
];
/**
 * The "To" choices as fixed objects. The select compares options by
 * identity: fresh objects on every edit made it re-pick the value and
 * report a change, which rebuilt them again, forever.
 */
const AUDIENCE = KINDS.map((kind) => ({
  value: kind.condition,
  label: kind.label,
  needsOpens: kind.needsOpens,
}));
const kindOf = (condition: CampaignStepCondition) =>
  KINDS.find((kind) => kind.condition === condition) ?? KINDS[0]!;

/** Day each email goes out, counting the first as day 1. */
export const sendDays = (steps: readonly SequenceNode[]) => {
  const out: number[] = [];
  let day = 1;
  steps.forEach((step, index) => {
    if (index > 0) day += step.delayDays;
    out.push(day);
  });
  return out;
};

/** The worst check of an email, for the dot on its card. */
const levelOf = (step: SequenceNode, index: number): CheckLevel => {
  const checks = checkEmail({
    subject: step.subject,
    body: step.body,
    first: index === 0,
  });
  return checks.some((c) => c.level === 'problem')
    ? 'problem'
    : checks.some((c) => c.level === 'warning')
      ? 'warning'
      : 'good';
};

type Selection = { kind: 'step'; index: number } | { kind: 'reply' };

/**
 * The sequence as a canvas: the entry point, each email as a node with the
 * wait on the connector before it, and what happens on reply at the end.
 * Selecting an email opens its editor on the right: wait and audience, the
 * subject and message with merge fields, a preview as the person sees it,
 * and checks for what would hurt delivery or replies.
 */
/** Sending one saved email to yourself, as the host wires it. */
export type SequenceTest = {
  onSend: (stepId: string) => void;
  pending: boolean;
  /** Edits not yet saved: a test would send the old copy. */
  blocked: boolean;
  note?: { stepId: string; text: string };
};

export function CampaignSequence(props: {
  steps: SequenceNode[];
  /** Offers "Send me a test" in each email's editor when set. */
  test?: SequenceTest;
  /** Shown in the top bar while edits are being written. */
  status?: string;
  rules: ReplyRules;
  onRules: (patch: Partial<ReplyRules>) => void;
  onChange: (steps: SequenceNode[]) => void;
  /** Drop the outer padding and frame, when the host already draws one. */
  bare?: boolean;
  /** The email whose editor is open at first. */
  initialSelected?: number;
}) {
  const [scale, setScale] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [selected, setSelected] = createSignal<Selection | undefined>(
    props.initialSelected === undefined
      ? undefined
      : { kind: 'step', index: props.initialSelected }
  );
  const [dropAt, setDropAt] = createSignal<number>();
  let drag: { x: number; y: number; pan: { x: number; y: number } } | null =
    null;

  const zoom = (factor: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
  const fit = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };
  const selectedIndex = () => {
    const s = selected();
    return s?.kind === 'step' && s.index < props.steps.length
      ? s.index
      : undefined;
  };
  const full = () => props.steps.length >= MAX_EMAILS;
  /**
   * The last email that has gone out to anyone. It and every email before it
   * are fixed: moving, deleting or adding above them would change which email
   * people already part-way through get next.
   */
  const lastSent = () => props.steps.findLastIndex((step) => step.sent > 0);
  const canAddAt = (at: number) => !full() && at > lastSent();
  const update = (index: number, patch: Partial<SequenceNode>) =>
    props.onChange(
      props.steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
    );
  /** Keeps the first email's wait at 0 whatever moved into its place. */
  const commit = (next: SequenceNode[]) =>
    props.onChange(
      next.map((step, i) =>
        i === 0
          ? { ...step, delayDays: 0, condition: 'always' }
          : step.delayDays < 1
            ? { ...step, delayDays: FOLLOW_UP_WAIT_DAYS }
            : step
      )
    );
  const insert = (at: number, condition: CampaignStepCondition = 'always') => {
    if (!canAddAt(at)) return;
    const next = [...props.steps];
    next.splice(at, 0, {
      ...blankEmail(at === 0 ? 0 : FOLLOW_UP_WAIT_DAYS),
      condition: at === 0 ? 'always' : condition,
    });
    commit(next);
    setSelected({ kind: 'step', index: at });
  };
  /** The copy goes right after it, or after the last sent email if later. */
  const duplicate = (index: number) => {
    const at = Math.max(index + 1, lastSent() + 1);
    if (!canAddAt(at)) return;
    const source = props.steps[index]!;
    const next = [...props.steps];
    next.splice(at, 0, {
      ...blankEmail(FOLLOW_UP_WAIT_DAYS),
      subject: source.subject,
      body: source.body,
      condition: source.condition,
    });
    commit(next);
    setSelected({ kind: 'step', index: at });
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= props.steps.length) return;
    if (index <= lastSent() || to <= lastSent()) return;
    const next = [...props.steps];
    const [step] = next.splice(index, 1);
    next.splice(to, 0, step!);
    commit(next);
    setSelected({ kind: 'step', index: to });
  };
  const remove = (index: number) => {
    if (index <= lastSent()) return;
    commit(props.steps.filter((_, i) => i !== index));
    setSelected(undefined);
  };
  const dayOf = createMemo(() => sendDays(props.steps));
  const lastDay = () => dayOf().at(-1) ?? 0;
  const needsWork = createMemo(
    () =>
      props.steps.filter((step, index) => levelOf(step, index) === 'problem')
        .length
  );

  const dropZone = (at: number) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(STEP_DRAG_TYPE)) return;
      event.preventDefault();
      setDropAt(at);
    },
    onDragLeave: () =>
      setDropAt((current) => (current === at ? undefined : current)),
    onDrop: (event: DragEvent) => {
      const condition = event.dataTransfer?.getData(STEP_DRAG_TYPE);
      setDropAt(undefined);
      if (!condition) return;
      event.preventDefault();
      insert(at, condition as CampaignStepCondition);
    },
  });

  return (
    <div
      class={cn(
        '@container/sequence flex h-full min-h-0',
        !props.bare && 'p-4'
      )}
    >
      <div
        class={cn(
          'flex min-h-0 flex-1 overflow-hidden',
          !props.bare && 'rounded-xl border border-edge-muted'
        )}
      >
        {/* The editor needs the room; the palette comes back when it closes. */}
        <Show when={selected() === undefined}></Show>

        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex h-11 shrink-0 items-center gap-3 overflow-hidden border-b border-edge-muted px-3 text-xs whitespace-nowrap text-ink-muted">
            <span class="tabular-nums">
              {props.steps.length}{' '}
              {props.steps.length === 1 ? 'email' : 'emails'} over{' '}
              {days(lastDay())}
            </span>
            <span class="flex items-center gap-1.5">
              <span
                class={cn(
                  'size-1.5 rounded-full',
                  props.rules.stopOnReply ? 'bg-success' : 'bg-warning'
                )}
              />
              {props.rules.stopOnReply
                ? 'Stops on reply'
                : 'Keeps sending after a reply'}
            </span>
            <Show when={props.rules.autoDraftReplies}>
              <span class="flex items-center gap-1 text-accent">
                <SparkleIcon class="size-3.5" />
                Drafts replies
              </span>
            </Show>
            <Show when={needsWork()}>
              <span class="flex items-center gap-1 text-failure">
                <WarningIcon class="size-3.5" />
                {needsWork() === 1
                  ? '1 email needs work'
                  : `${needsWork()} emails need work`}
              </span>
            </Show>
            <span class="ml-auto min-w-0 truncate">
              {props.status ?? 'Saved'}
            </span>
          </div>

          <div
            class="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
            style={{
              'background-image':
                'radial-gradient(var(--color-edge-muted) 0.7px, transparent 0.7px)',
              'background-size': `${16 * scale()}px ${16 * scale()}px`,
              'background-position': `${pan().x}px ${pan().y}px`,
            }}
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              drag = { x: event.clientX, y: event.clientY, pan: pan() };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              setPan({
                x: drag.pan.x + event.clientX - drag.x,
                y: drag.pan.y + event.clientY - drag.y,
              });
            }}
            onPointerUp={() => {
              drag = null;
            }}
            onWheel={(event) => {
              if (!(event.ctrlKey || event.metaKey)) {
                setPan((p) => ({
                  x: p.x - event.deltaX,
                  y: p.y - event.deltaY,
                }));
              } else zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
              event.preventDefault();
            }}
          >
            <ol
              aria-label="Sequence"
              class="pointer-events-none absolute top-8 left-1/2 flex w-80 origin-top flex-col items-center"
              style={{
                transform: `translate(calc(-50% + ${pan().x}px), ${pan().y}px) scale(${scale()})`,
              }}
            >
              <li class="pointer-events-auto w-full">
                <NodeCard
                  icon={EnterIcon}
                  tone="text-accent bg-accent/10"
                  title="Contact enters the campaign"
                  detail="When the campaign launches or a person is added"
                />
              </li>
              <Show when={!props.steps.length}>
                <li class="flex w-full flex-col items-center">
                  <div class="h-6 w-px bg-edge" />
                  <button
                    type="button"
                    class="pointer-events-auto flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-accent/50 bg-accent/5 px-4 py-5 text-center not-touch:hover:bg-accent/10"
                    onClick={() => insert(0)}
                  >
                    <span class="flex items-center gap-1.5 text-sm font-medium text-accent">
                      <PlusIcon class="size-4" />
                      Write the first email
                    </span>
                    <span class="text-xs text-ink-muted">
                      Then add follow-ups for people who don’t reply
                    </span>
                  </button>
                </li>
              </Show>
              <For each={props.steps}>
                {(step, index) => (
                  <li class="flex w-full flex-col items-center">
                    <Connector
                      wait={index() === 0 ? undefined : step.delayDays}
                      onWaitChange={(delayDays) =>
                        update(index(), { delayDays })
                      }
                      disabled={!canAddAt(index())}
                      onAdd={() => insert(index())}
                      dropping={dropAt() === index()}
                      {...dropZone(index())}
                    />
                    <div class="pointer-events-auto w-full">
                      <StepCard
                        step={step}
                        index={index()}
                        total={props.steps.length}
                        day={dayOf()[index()] ?? 1}
                        level={levelOf(step, index())}
                        selected={selectedIndex() === index()}
                        onClick={() =>
                          setSelected((s) =>
                            s?.kind === 'step' && s.index === index()
                              ? undefined
                              : { kind: 'step', index: index() }
                          )
                        }
                      />
                    </div>
                  </li>
                )}
              </For>
              <li class="flex w-full flex-col items-center">
                <Connector
                  disabled={!canAddAt(props.steps.length)}
                  onAdd={() => insert(props.steps.length)}
                  dropping={dropAt() === props.steps.length}
                  {...dropZone(props.steps.length)}
                />
                <div class="pointer-events-auto w-full">
                  <NodeCard
                    icon={ReplyIcon}
                    tone="text-success bg-success/10"
                    title="When someone replies"
                    detail={
                      [
                        props.rules.stopOnReply
                          ? 'Their sequence stops'
                          : 'Their sequence keeps going',
                        props.rules.autoDraftReplies && 'an answer is drafted',
                      ]
                        .filter(Boolean)
                        .join(', ') + '.'
                    }
                    selected={selected()?.kind === 'reply'}
                    onClick={() =>
                      setSelected((s) =>
                        s?.kind === 'reply' ? undefined : { kind: 'reply' }
                      )
                    }
                  />
                </div>
                <div class="h-6 w-px bg-edge" />
                <span class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-edge-muted bg-panel px-3 py-1 text-xs text-ink-muted">
                  <FlagIcon class="size-3.5" />
                  {props.steps.length
                    ? `Sequence ends after day ${lastDay()}`
                    : 'No emails yet'}
                </span>
              </li>
            </ol>

            <CanvasZoomToolbar
              scale={scale()}
              onZoom={zoom}
              onFit={fit}
              hasSelection={false}
              onFitSelection={fit}
            />
          </div>
        </div>

        {/* Read the step fresh each time: a save swaps the object and its id. */}
        <Show when={selectedIndex() !== undefined}>
          <EmailEditor
            step={props.steps[selectedIndex()!]!}
            index={selectedIndex()!}
            total={props.steps.length}
            day={dayOf()[selectedIndex()!] ?? 1}
            firstSubject={props.steps[0]?.subject ?? ''}
            trackOpens={props.rules.trackOpens}
            canDuplicate={!full()}
            fixed={selectedIndex()! <= lastSent()}
            canMoveEarlier={selectedIndex()! - 1 > lastSent()}
            canMoveLater={selectedIndex()! + 1 > lastSent()}
            test={props.test}
            onChange={(patch) => update(selectedIndex()!, patch)}
            onMove={(by) => move(selectedIndex()!, by)}
            onDuplicate={() => duplicate(selectedIndex()!)}
            onRemove={() => remove(selectedIndex()!)}
            onClose={() => setSelected(undefined)}
          />
        </Show>
        <Show when={selected()?.kind === 'reply'}>
          <Inspector
            icon={ReplyIcon}
            title="When someone replies"
            onClose={() => setSelected(undefined)}
          >
            <RuleRow
              title="Stop their sequence"
              detail="A reply ends the follow-ups for that person. Out-of-office replies don’t count."
              checked={props.rules.stopOnReply}
              onChange={(stopOnReply) => props.onRules({ stopOnReply })}
            />
            <RuleRow
              title="Draft an answer with Macro AI"
              detail="Each reply gets a draft in your voice, waiting on the Overview for you to check. Nothing sends on its own."
              checked={props.rules.autoDraftReplies}
              onChange={(autoDraftReplies) =>
                props.onRules({ autoDraftReplies })
              }
            />
            <RuleRow
              title="Track opens"
              detail="Needed to send a follow-up only to people who opened, or didn’t. Apple Mail opens images on its own, so opens overcount."
              checked={props.rules.trackOpens}
              onChange={(trackOpens) => props.onRules({ trackOpens })}
            />
          </Inspector>
        </Show>
      </div>
    </div>
  );
}

const LEVEL_DOT: Record<CheckLevel, string> = {
  good: 'bg-success',
  warning: 'bg-warning',
  problem: 'bg-failure',
};
const LEVEL_TITLE: Record<CheckLevel, string> = {
  good: 'Ready',
  warning: 'Could be better',
  problem: 'Needs work before launch',
};

function StepCard(props: {
  step: SequenceNode;
  index: number;
  total: number;
  day: number;
  level: CheckLevel;
  selected: boolean;
  onClick: () => void;
}) {
  const kind = () =>
    kindOf(props.index === 0 ? 'always' : props.step.condition);
  const replyShare = () =>
    props.step.sent ? (props.step.replied / props.step.sent) * 100 : 0;
  const snippet = () => fillFields(props.step.body).replace(/\s+/g, ' ').trim();
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={cn(
        'flex w-full flex-col gap-2 rounded-xl border bg-panel p-3 text-left shadow-xs',
        props.selected
          ? 'border-accent ring-2 ring-accent/20'
          : 'border-edge not-touch:hover:border-ink-extra-muted'
      )}
    >
      <span class="flex w-full items-center gap-2.5">
        <span
          class={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            kind().tone
          )}
        >
          {(() => {
            const Icon = kind().icon;
            return <Icon class="size-4" />;
          })()}
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium">
              {stepTitle(props.index, props.total)}
            </span>
            <span class="shrink-0 text-xs text-ink-muted tabular-nums">
              Day {props.day}
            </span>
            <Show when={props.index > 0 && props.step.condition !== 'always'}>
              <span class="shrink-0 rounded-full bg-hover px-1.5 py-px text-[11px] text-ink-muted">
                {props.step.condition === 'opened'
                  ? 'If opened'
                  : 'If not opened'}
              </span>
            </Show>
          </span>
          <span class="truncate text-xs text-ink-muted">
            {props.step.subject
              ? fillFields(props.step.subject)
              : props.index === 0
                ? 'No subject yet'
                : 'Replies in the same thread'}
          </span>
        </span>
        <span
          class={cn('size-2 shrink-0 rounded-full', LEVEL_DOT[props.level])}
          title={LEVEL_TITLE[props.level]}
        />
      </span>
      <span
        class={cn(
          'line-clamp-2 w-full text-xs',
          snippet() ? 'text-ink-muted' : 'text-ink-extra-muted italic'
        )}
      >
        {snippet() || 'No message yet'}
      </span>
      <Show when={props.step.sent > 0}>
        <span class="flex w-full items-center gap-2 border-t border-edge-muted pt-2 text-xs text-ink-muted tabular-nums">
          <span>{formatCount(props.step.sent)} sent</span>
          <span class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-hover">
            <span
              class="block h-full rounded-full bg-success"
              style={{ width: `${Math.min(100, replyShare() * 5)}%` }}
            />
          </span>
          <span class="text-success">
            {formatShare(props.step.replied, props.step.sent)} replied
          </span>
        </span>
      </Show>
    </button>
  );
}

function NodeCard(props: {
  icon: typeof EnvelopeIcon;
  tone: string;
  title: string;
  detail: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={!props.onClick}
      onClick={props.onClick}
      class={cn(
        'flex w-full items-center gap-2.5 rounded-xl border bg-panel p-3 text-left shadow-xs',
        props.selected
          ? 'border-accent ring-2 ring-accent/20'
          : 'border-edge enabled:not-touch:hover:border-ink-extra-muted'
      )}
    >
      <span
        class={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          props.tone
        )}
      >
        <Icon class="size-4" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium">{props.title}</span>
        <span class="text-xs text-ink-muted">{props.detail}</span>
      </span>
    </button>
  );
}

/** The line between two nodes: the wait, an add button, and a drop target. */
function Connector(props: {
  wait?: number;
  onWaitChange?: (days: number) => void;
  onAdd: () => void;
  disabled?: boolean;
  dropping: boolean;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}) {
  return (
    <div
      class="pointer-events-auto relative flex h-16 w-full items-center justify-center"
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      <span
        class={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
          props.dropping ? 'bg-accent' : 'bg-edge'
        )}
      />
      <Show
        when={!props.dropping}
        fallback={
          <span class="relative rounded-full border border-dashed border-accent bg-accent/10 px-3 py-1 text-xs text-accent">
            Drop to add here
          </span>
        }
      >
        <button
          type="button"
          aria-label="Add a follow-up here"
          title="Add a follow-up here"
          disabled={props.disabled}
          class="relative flex size-6 items-center justify-center rounded-full border border-edge bg-panel text-ink-muted disabled:opacity-40 not-touch:enabled:hover:border-accent not-touch:enabled:hover:text-accent"
          onClick={props.onAdd}
        >
          <PlusIcon class="size-3.5" />
        </button>
        <Show when={props.wait !== undefined}>
          <WaitPill
            value={props.wait ?? FOLLOW_UP_WAIT_DAYS}
            onChange={(value) => props.onWaitChange?.(value)}
          />
        </Show>
      </Show>
    </div>
  );
}

function Inspector(props: {
  icon: typeof EnvelopeIcon;
  title: string;
  detail?: string;
  actions?: JSX.Element;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  wide?: boolean;
}) {
  const Icon = props.icon;
  return (
    <aside
      class={cn(
        'flex shrink-0 flex-col border-l border-edge-muted bg-panel',
        props.wide ? 'w-[min(30rem,55%)]' : 'w-80'
      )}
    >
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-edge-muted px-3">
        <Icon class="size-4 shrink-0 text-ink-muted" />
        <span class="truncate text-sm font-medium">{props.title}</span>
        <Show when={props.detail}>
          <span class="shrink-0 text-xs text-ink-muted tabular-nums">
            {props.detail}
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-0.5">
          {props.actions}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            tooltip="Close"
            onClick={props.onClose}
          >
            <XIcon class="size-4" />
          </Button>
        </span>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {props.children}
      </div>
      <Show when={props.footer}>
        <footer class="flex shrink-0 items-center border-t border-edge-muted p-3">
          {props.footer}
        </footer>
      </Show>
    </aside>
  );
}

/** A setting with a switch, as on the canvas's reply node. */
export function RuleRow(props: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div class="flex items-start gap-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-sm">{props.title}</span>
        <span class="text-xs text-ink-muted">{props.detail}</span>
      </div>
      <ToggleSwitch
        size="sm"
        aria-label={props.title}
        checked={props.checked}
        onChange={props.onChange}
      />
    </div>
  );
}

/** Days to wait before a follow-up, on Macro's number field. */
export function WaitInput(props: {
  label: string;
  value: number;
  onChange: (days: number) => void;
}) {
  // What is typed, kept while editing so the field can be cleared and
  // retyped; the saved number snaps back only on blur.
  const [text, setText] = createSignal<string>();
  return (
    <NumberUnitInput
      format={false}
      step={1}
      minValue={1}
      maxValue={MAX_WAIT_DAYS}
      value={text() ?? String(props.value)}
      onChange={(next) => {
        setText(next);
        const n = next.trim() ? Math.round(Number(next)) : Number.NaN;
        if (Number.isFinite(n) && n >= 1 && n !== props.value)
          props.onChange(Math.min(n, MAX_WAIT_DAYS));
      }}
    >
      <NumberUnitInput.Controls align="inline-start">
        <NumberUnitInput.DecrementTrigger
          size="icon-sm"
          aria-label="One day less"
          tooltip="One day less"
        />
      </NumberUnitInput.Controls>
      <NumberUnitInput.Frame>
        <NumberUnitInput.Input
          aria-label={props.label}
          class="w-10 px-2 text-right text-sm tabular-nums"
          onBlur={() => setText(undefined)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
        <NumberUnitInput.Unit>
          {props.value === 1 ? 'day' : 'days'}
        </NumberUnitInput.Unit>
      </NumberUnitInput.Frame>
      <NumberUnitInput.Controls>
        <NumberUnitInput.IncrementTrigger
          size="icon-sm"
          aria-label="One day more"
          tooltip="One day more"
        />
      </NumberUnitInput.Controls>
    </NumberUnitInput>
  );
}

/** The wait on the canvas line; click it to change the days in place. */
function WaitPill(props: { value: number; onChange: (days: number) => void }) {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  return (
    <Popover placement="right" gutter={8} modal={false}>
      <Popover.Trigger
        ref={setTrigger}
        type="button"
        class="absolute top-1/2 left-1/2 ml-6 flex -translate-y-1/2 items-center gap-1 rounded-full border border-edge bg-panel px-2 py-0.5 text-xs text-ink-muted tabular-nums not-touch:hover:border-accent not-touch:hover:text-ink data-expanded:border-accent data-expanded:text-ink"
        aria-label={`Wait ${days(props.value)}. Change`}
      >
        <ClockIcon class="size-3.5" />
        Wait {days(props.value)}
      </Popover.Trigger>
      <Popover.Portal
        mount={trigger()?.closest<HTMLElement>('.portal-scope') ?? undefined}
      >
        <Popover.Content class="menu-surface z-action-menu flex flex-col gap-2 p-3 outline-none">
          <Popover.Title class="text-xs text-ink-muted">
            Wait after the previous email
          </Popover.Title>
          <WaitInput
            label="Days to wait"
            value={props.value}
            onChange={props.onChange}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

const CHECK_ICON: Record<CheckLevel, typeof CheckCircleIcon> = {
  good: CheckCircleIcon,
  warning: WarningIcon,
  problem: WarningIcon,
};
const CHECK_TONE: Record<CheckLevel, string> = {
  good: 'text-success',
  warning: 'text-warning',
  problem: 'text-failure',
};

/**
 * One email, written in place: who gets it and when, the subject and
 * message with merge fields inserted at the cursor, the email as Jane at
 * Acme would read it, and checks as you type.
 */
function EmailEditor(props: {
  step: SequenceNode;
  index: number;
  total: number;
  day: number;
  firstSubject: string;
  trackOpens: boolean;
  canDuplicate: boolean;
  /** Sent to someone already, or above an email that was. */
  fixed: boolean;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  test?: SequenceTest;
  onChange: (patch: Partial<SequenceNode>) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = createSignal<'write' | 'preview'>('write');
  let lastField: HTMLInputElement | HTMLTextAreaElement | undefined;
  let bodyField: HTMLTextAreaElement | undefined;
  const title = () => stepTitle(props.index, props.total);
  /** Its copy went out to people: what they got stays what it says. */
  const locked = () => props.step.sent > 0;
  const fixedReason = () =>
    locked()
      ? `Already sent to ${formatCount(props.step.sent)} ${props.step.sent === 1 ? 'person' : 'people'}`
      : 'An email after this one has already gone out';
  const checks = createMemo(() =>
    checkEmail({
      subject: props.step.subject,
      body: props.step.body,
      first: props.index === 0,
    })
  );
  const audience = createMemo(() =>
    AUDIENCE.filter(
      (option) =>
        !option.needsOpens ||
        props.trackOpens ||
        option.value === props.step.condition
    )
  );

  /** Puts a merge field where the cursor was, in the subject or message. */
  const insertField = (tag: string) => {
    const field = lastField ?? bodyField;
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const value = field.value.slice(0, start) + tag + field.value.slice(end);
    props.onChange(
      field.dataset.field === 'subject' ? { subject: value } : { body: value }
    );
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(start + tag.length, start + tag.length);
    });
  };
  const remember = (event: FocusEvent) => {
    lastField = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
  };
  const subjectShown = () =>
    props.step.subject
      ? fillFields(props.step.subject)
      : props.index === 0
        ? '(no subject)'
        : `Re: ${fillFields(props.firstSubject) || '(no subject)'}`;

  return (
    <Inspector
      wide
      icon={kindOf(props.index === 0 ? 'always' : props.step.condition).icon}
      title={title()}
      detail={`Day ${props.day}`}
      onClose={props.onClose}
      actions={
        <>
          <Show when={props.test}>
            {(test) => (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Send me a test"
                tooltip={
                  !props.step.saved || test().blocked
                    ? 'Saving first…'
                    : 'Send me a test'
                }
                disabled={test().pending || test().blocked || !props.step.saved}
                onClick={() => test().onSend(props.step.id)}
              >
                <PaperPlaneTiltIcon class="size-4" />
              </Button>
            )}
          </Show>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move earlier"
            tooltip={
              props.fixed
                ? fixedReason()
                : props.canMoveEarlier
                  ? 'Move earlier'
                  : 'The email before this one has already gone out'
            }
            disabled={props.index === 0 || props.fixed || !props.canMoveEarlier}
            onClick={() => props.onMove(-1)}
          >
            <ArrowUpIcon class="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move later"
            tooltip={props.fixed ? fixedReason() : 'Move later'}
            disabled={
              props.index === props.total - 1 ||
              props.fixed ||
              !props.canMoveLater
            }
            onClick={() => props.onMove(1)}
          >
            <ArrowDownIcon class="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Duplicate"
            tooltip="Duplicate"
            disabled={!props.canDuplicate}
            onClick={props.onDuplicate}
          >
            <CopyIcon class="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${title().toLowerCase()}`}
            tooltip={props.fixed ? fixedReason() : 'Delete'}
            class="text-failure"
            disabled={props.fixed}
            onClick={props.onRemove}
          >
            <TrashIcon class="size-4" />
          </Button>
        </>
      }
    >
      {/* Laid out like Macro's own email composer: labelled rows, then
          the message on the page, no boxes. */}
      <Show when={locked()}>
        <p
          role="note"
          class="flex items-start gap-2 rounded-md bg-hover px-3 py-2 text-xs text-ink-muted"
        >
          <LockIcon class="mt-0.5 size-3.5 shrink-0" />
          {fixedReason()}, so its words stay as they were. Duplicate it to write
          a new version for later.
        </p>
      </Show>
      <div class="-mt-2 flex flex-col">
        <Show when={props.index > 0}>
          <ComposeFieldRow label="Wait">
            <div class="flex flex-wrap items-center gap-2">
              <WaitInput
                label={`Days before ${title().toLowerCase()}`}
                value={props.step.delayDays}
                onChange={(delayDays) => props.onChange({ delayDays })}
              />
              <span class="text-sm text-ink-muted">
                after the previous email
              </span>
            </div>
          </ComposeFieldRow>
          <ComposeFieldRow label="To">
            <div class="flex flex-col gap-1">
              <SelectInput
                label="Send to"
                class="w-full max-w-72"
                disabled={locked()}
                value={props.step.condition}
                options={audience()}
                onChange={(value) => {
                  if (value !== props.step.condition)
                    props.onChange({
                      condition: value as CampaignStepCondition,
                    });
                }}
              />
              <Show when={!props.trackOpens}>
                <span class="text-xs text-ink-muted">
                  Turn on Track opens to send only to people who opened, or
                  didn’t.
                </span>
              </Show>
            </div>
          </ComposeFieldRow>
        </Show>
        <ComposeFieldRow label="Subject">
          <input
            type="text"
            data-field="subject"
            aria-label={`${title()} subject`}
            autocomplete="off"
            data-1p-ignore
            value={props.step.subject}
            readOnly={locked()}
            placeholder={
              props.index > 0
                ? 'Empty replies in the same thread'
                : 'Quick question, {{first_name}}'
            }
            class="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-placeholder"
            onFocus={remember}
            onInput={(event) =>
              props.onChange({ subject: event.currentTarget.value })
            }
          />
        </ComposeFieldRow>
      </div>

      <Show
        when={mode() === 'write'}
        fallback={
          <div class="flex min-h-64 flex-1 flex-col gap-3">
            <p class="text-xs text-ink-muted">
              As {SAMPLE_PERSON.name} sees it
            </p>
            <p class="text-base font-medium">{subjectShown()}</p>
            <p class="text-base whitespace-pre-wrap">
              {fillFields(props.step.body) || (
                <span class="text-ink-placeholder">No message yet</span>
              )}
            </p>
          </div>
        }
      >
        <textarea
          ref={bodyField}
          data-field="body"
          aria-label={`${title()} message`}
          value={props.step.body}
          readOnly={locked()}
          placeholder={
            props.index === 0
              ? 'Hi {{first_name|there}},\n\n…'
              : 'A short nudge works best.'
          }
          class="min-h-64 w-full flex-1 resize-none bg-transparent text-base leading-relaxed text-ink outline-none placeholder:text-ink-placeholder"
          onFocus={remember}
          onInput={(event) =>
            props.onChange({ body: event.currentTarget.value })
          }
        />
      </Show>

      <div class="flex flex-wrap items-center gap-1 border-t border-edge-muted pt-3">
        <Show when={mode() === 'write' && !locked()}>
          <BracketsIcon class="mr-0.5 size-3.5 text-ink-muted" />
          <For each={MERGE_FIELDS}>
            {(field) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                tooltip={`Insert ${field.tag}`}
                // Keep the cursor where it was in the field.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertField(field.tag)}
              >
                {field.label}
              </Button>
            )}
          </For>
        </Show>
        <span class="ml-auto flex items-center gap-2">
          <Tabs
            aria-label="Message view"
            size="sm"
            options={[
              { value: 'write', label: 'Write' },
              { value: 'preview', label: 'Preview' },
            ]}
            value={mode()}
            onChange={(value) => setMode(value as 'write' | 'preview')}
          />
        </span>
      </div>

      <section aria-label="Checks" class="flex flex-col gap-1.5">
        <For each={checks()}>
          {(check) => {
            const Icon = CHECK_ICON[check.level];
            return (
              <p
                class={cn(
                  'flex items-start gap-2 text-xs',
                  check.level === 'good' ? 'text-ink-muted' : 'text-ink'
                )}
              >
                <Icon
                  class={cn('mt-px size-3.5 shrink-0', CHECK_TONE[check.level])}
                />
                {check.label}
              </p>
            );
          }}
        </For>
      </section>

      <Show
        when={
          props.test?.note?.stepId === props.step.id && props.test.note.text
        }
      >
        {(text) => (
          <p
            role="status"
            class="flex items-center gap-2 text-xs text-ink-muted"
          >
            <PaperPlaneTiltIcon class="size-3.5 shrink-0" />
            {text()}
          </p>
        )}
      </Show>

      <Show when={props.step.sent > 0}>
        <dl class="grid grid-cols-3 gap-2 rounded-lg border border-edge-muted p-2.5 text-center text-xs">
          <div>
            <dt class="text-ink-muted">Sent</dt>
            <dd class="text-sm tabular-nums">{formatCount(props.step.sent)}</dd>
          </div>
          <div>
            <dt class="text-ink-muted">Opened</dt>
            <dd class="text-sm tabular-nums">
              {props.trackOpens
                ? formatShare(props.step.opened, props.step.sent)
                : '—'}
            </dd>
          </div>
          <div>
            <dt class="text-ink-muted">Replied</dt>
            <dd class="text-sm text-success tabular-nums">
              {formatShare(props.step.replied, props.step.sent)}
            </dd>
          </div>
        </dl>
      </Show>
    </Inspector>
  );
}
