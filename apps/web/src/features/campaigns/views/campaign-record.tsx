import { ViewBreadcrumbs } from '@app/components/view-shell';
import { ListNavigationButtons } from '@components/app/split-layout/components/SplitHeader';
import { toast } from '@core/component/Toast/Toast';
import CopyIcon from '@icon/system/regular/copy.svg';
import DotsThreeIcon from '@icon/system/regular/dots-three.svg';
import EnvelopeIcon from '@icon/system/regular/envelope-simple.svg';
import GearIcon from '@icon/system/regular/gear.svg';
import LinkIcon from '@icon/system/regular/link.svg';
import ListNumbersIcon from '@icon/system/regular/list-numbers.svg';
import PauseIcon from '@icon/system/regular/pause.svg';
import PencilIcon from '@icon/system/regular/pencil-simple.svg';
import PlayIcon from '@icon/system/regular/play.svg';
import SquaresFourIcon from '@icon/system/regular/squares-four.svg';
import StackIcon from '@icon/system/regular/stack-simple.svg';
import TrashIcon from '@icon/system/regular/trash.svg';
import UsersIcon from '@icon/system/regular/users.svg';
import { createElementSize } from '@solid-primitives/resize-observer';
import { Button, Dropdown, Tabs, Tooltip } from '@ui';
import {
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import type { CampaignAction } from '../components/campaign-table';
import { stepTitle } from '../core/format';
import { nodesToInputs, stepsToNodes } from '../core/rows';
import type { Campaign } from '../core/sample';
import type { CampaignSection } from '../core/sections';
import {
  useCampaignQuery,
  useCampaignStatsQuery,
  useCampaignStepsQuery,
  useSaveCampaignSteps,
  useSendCampaignTest,
  useUpdateCampaignSettings,
} from '../queries';
import { CampaignOverview } from './campaign-overview';
import { CampaignPeople } from './campaign-people';
import { CampaignSequence, type SequenceNode } from './campaign-sequence';
import { CampaignSettings } from './campaign-settings';
import { CampaignStepReport } from './campaign-step';

const SECTIONS = [
  { value: 'overview', label: 'Overview', icon: SquaresFourIcon },
  { value: 'sequence', label: 'Sequence', icon: ListNumbersIcon },
  { value: 'people', label: 'People', icon: UsersIcon },
  { value: 'settings', label: 'Settings', icon: GearIcon },
] as const;

/**
 * One campaign, laid out like a CRM record: the trail back to the list, the
 * section tabs, and the campaign's primary action on the right.
 */
export function CampaignRecord(props: {
  campaign: Campaign;
  section: CampaignSection;
  viewName: string;
  onSectionChange: (section: CampaignSection) => void;
  /** The email whose report is open, over the overview. */
  stepId?: string;
  onOpenStep: (stepId: string | undefined) => void;
  onClose: () => void;
  onEdit: () => void;
  onAction: (action: CampaignAction) => void;
}) {
  let container: HTMLDivElement | undefined;
  const size = createElementSize(() => container);
  const compact = () => (size.width ?? 0) < 820;
  onMount(() => container?.focus());
  const running = () => props.campaign.status === 'active';
  const canStart = () =>
    props.campaign.status === 'paused' || props.campaign.status === 'draft';
  // The open email of the sequence, for its breadcrumb and item navigation.
  const steps = useCampaignStepsQuery(() => props.campaign.id);
  const ordered = createMemo(() =>
    [...(steps.data ?? [])].sort((a, b) => a.position - b.position)
  );
  const stepIndex = () =>
    ordered().findIndex((step) => step.id === props.stepId);
  const openStep = () =>
    props.section === 'overview' && stepIndex() >= 0 ? stepIndex() : undefined;
  const stepNavigation = {
    canPrevious: () => (openStep() ?? 0) > 0,
    canNext: () => (openStep() ?? Infinity) < ordered().length - 1,
    previous: () => {
      const previous = ordered()[(openStep() ?? 0) - 1];
      if (previous) props.onOpenStep(previous.id);
    },
    next: () => {
      const next = ordered()[(openStep() ?? Infinity) + 1];
      if (next) props.onOpenStep(next.id);
    },
  };

  return (
    <ViewBreadcrumbs.Root
      value={openStep() === undefined ? 'campaign' : 'step'}
      onChange={(value) => {
        if (value === 'campaigns') props.onClose();
        if (value === 'campaign') props.onOpenStep(undefined);
      }}
    >
      <ViewBreadcrumbs.Item value="campaigns" metadata={{}} order={0}>
        {(item) => (
          <Tooltip label={`Back to ${props.viewName}`} class="min-w-0">
            <ViewBreadcrumbs.Button
              isActive={item.isActive()}
              onClick={item.onSelect}
            >
              <span class="truncate">{props.viewName}</span>
            </ViewBreadcrumbs.Button>
          </Tooltip>
        )}
      </ViewBreadcrumbs.Item>
      <ViewBreadcrumbs.Item value="campaign" metadata={{}} order={1}>
        {(item) => (
          <ViewBreadcrumbs.Button
            isActive={item.isActive()}
            onClick={item.onSelect}
            class="gap-1.5"
          >
            <StackIcon class="size-4 shrink-0 text-ink-muted" />
            <span class="truncate">{props.campaign.name}</span>
          </ViewBreadcrumbs.Button>
        )}
      </ViewBreadcrumbs.Item>
      <Show when={openStep() !== undefined}>
        <ViewBreadcrumbs.Item value="step" metadata={{}} order={2}>
          {(item) => (
            <ViewBreadcrumbs.Button
              isActive={item.isActive()}
              onClick={item.onSelect}
              class="gap-1.5"
            >
              <EnvelopeIcon class="size-4 shrink-0 text-ink-muted" />
              <span class="truncate">
                {stepTitle(openStep() ?? 0, ordered().length)}
              </span>
            </ViewBreadcrumbs.Button>
          )}
        </ViewBreadcrumbs.Item>
      </Show>
      <div
        ref={container}
        tabindex={-1}
        class="flex size-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
        onKeyDown={(event) => {
          // Escape in an open menu, list or dialog closes that, not the record.
          const target = event.target as Element;
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !target.closest(
              '[role=menu],[role=dialog],input,textarea,[contenteditable=true]'
            )
          ) {
            // An open email steps back to the overview before the record closes.
            if (openStep() !== undefined) props.onOpenStep(undefined);
            else props.onClose();
          }
        }}
      >
        <div class="flex h-12 min-w-0 shrink-0 items-center gap-2 px-3">
          <Show when={openStep() !== undefined}>
            <ListNavigationButtons navigation={stepNavigation} />
          </Show>
          <ViewBreadcrumbs.Outlet
            aria-label="Campaign location"
            class="min-w-0 shrink"
          />
          <div class="min-w-0 overflow-x-auto">
            <Tabs
              aria-label="Campaign sections"
              class="shrink-0"
              options={SECTIONS.map((section) => ({
                value: section.value,
                label: section.label,
                icon: compact() ? section.icon : undefined,
              }))}
              iconOnly={compact()}
              value={props.section}
              onChange={props.onSectionChange}
            />
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-2">
            {/* Every tab edits in place, as in Instantly and Warmbly; only a
                draft needs a way back to the next thing it is missing. */}
            <Show when={props.campaign.status === 'draft'}>
              <Button variant="ghost" size="sm" onClick={props.onEdit}>
                <PencilIcon class="size-4" />
                <Show when={!compact()}>Continue setup</Show>
              </Button>
            </Show>
            <Show when={running()}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => props.onAction('pause')}
              >
                <PauseIcon class="size-4" />
                Pause
              </Button>
            </Show>
            <Show when={canStart()}>
              <Button
                size="sm"
                onClick={() =>
                  props.onAction(
                    props.campaign.status === 'paused' ? 'resume' : 'launch'
                  )
                }
              >
                <PlayIcon class="size-4" />
                {props.campaign.status === 'paused' ? 'Resume' : 'Launch'}
              </Button>
            </Show>
            <RecordMenu
              name={props.campaign.name}
              onSettings={() => props.onSectionChange('settings')}
              onAction={props.onAction}
            />
          </div>
        </div>
        <div class="relative min-h-0 min-w-0 flex-1">
          <Switch>
            <Match when={props.section === 'overview'}>
              <Show
                when={props.stepId}
                fallback={
                  <CampaignOverview
                    campaignId={props.campaign.id}
                    onOpenSection={props.onSectionChange}
                    onOpenStep={props.onOpenStep}
                  />
                }
              >
                {(stepId) => (
                  <CampaignStepReport
                    campaignId={props.campaign.id}
                    stepId={stepId()}
                    onOpenStep={props.onOpenStep}
                    onOpenSection={props.onSectionChange}
                  />
                )}
              </Show>
            </Match>
            <Match when={props.section === 'sequence'}>
              <SequenceSection campaignId={props.campaign.id} />
            </Match>
            <Match when={props.section === 'people'}>
              <CampaignPeople
                campaign={props.campaign}
                onOpenStep={props.onOpenStep}
              />
            </Match>
            <Match when={props.section === 'settings'}>
              <CampaignSettings
                campaign={props.campaign}
                onAction={props.onAction}
              />
            </Match>
          </Switch>
        </div>
      </div>
    </ViewBreadcrumbs.Root>
  );
}

/** The campaign's less frequent actions, behind ⋯ like any Macro record. */
function RecordMenu(props: {
  name: string;
  onSettings: () => void;
  onAction: (action: CampaignAction) => void;
}) {
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast.success('Link copied');
    } catch {
      toast.failure('Couldn’t copy the link');
    }
  };
  return (
    <Dropdown>
      <Dropdown.Trigger
        as={Button}
        variant="ghost"
        size="icon-sm"
        aria-label={`More actions for ${props.name}`}
      >
        <DotsThreeIcon class="size-4" />
      </Dropdown.Trigger>
      <Dropdown.Content class="min-w-48">
        <Dropdown.Group>
          <Dropdown.Item onSelect={copyLink}>
            <LinkIcon class="size-4 text-ink-muted" />
            Copy link
          </Dropdown.Item>
          <Dropdown.Item onSelect={() => props.onAction('duplicate')}>
            <CopyIcon class="size-4 text-ink-muted" />
            Duplicate
          </Dropdown.Item>
          <Dropdown.Item onSelect={props.onSettings}>
            <GearIcon class="size-4 text-ink-muted" />
            Settings
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
  );
}

const SAVE_DELAY_MS = 800;

/**
 * The saved sequence on the canvas. Edits show at once and are written a
 * moment after the last change, the way documents save.
 */
function SequenceSection(props: { campaignId: string }) {
  const id = () => props.campaignId;
  const campaign = useCampaignQuery(id);
  const steps = useCampaignStepsQuery(id);
  const stats = useCampaignStatsQuery(id);
  const saveSteps = useSaveCampaignSteps();
  const sendTest = useSendCampaignTest();
  const [testNote, setTestNote] = createSignal<{
    stepId: string;
    text: string;
  }>();
  const updateSettings = useUpdateCampaignSettings();
  const [draft, setDraft] = createSignal<SequenceNode[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (!timer) return;
    clearTimeout(timer);
    flush();
  });

  const nodes = () => draft() ?? stepsToNodes(steps.data ?? [], stats.data);
  const flush = () => {
    timer = undefined;
    const pending = draft();
    if (!pending) return;
    saveSteps.mutate(
      { id: id(), steps: nodesToInputs(pending) },
      // Keep edits made while this save was in flight.
      { onSuccess: () => draft() === pending && setDraft(undefined) }
    );
  };
  const change = (next: SequenceNode[]) => {
    setDraft(next);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  const status = () =>
    saveSteps.isError
      ? 'Not saved'
      : draft() || saveSteps.isPending
        ? 'Saving…'
        : undefined;

  return (
    <Show when={steps.isSuccess && campaign.data}>
      {(loaded) => (
        <CampaignSequence
          steps={nodes()}
          status={status()}
          onChange={change}
          test={{
            pending: sendTest.isPending,
            blocked: Boolean(draft()) || saveSteps.isPending,
            note: testNote(),
            onSend: (stepId) => {
              setTestNote({ stepId, text: 'Sending a test…' });
              sendTest.mutate(
                { id: id(), stepId },
                {
                  onSuccess: (result) =>
                    setTestNote({
                      stepId,
                      text: result.sent[0]
                        ? `Test sent to ${result.sent[0].to}. Check your inbox.`
                        : 'Nothing to send for this email.',
                    }),
                  onError: () =>
                    setTestNote({
                      stepId,
                      text: "The test didn't send. Check the sender in Settings.",
                    }),
                }
              );
            },
          }}
          rules={{
            stopOnReply: loaded().settings.stopOnReply,
            autoDraftReplies: loaded().settings.autoDraftReplies ?? false,
            trackOpens: loaded().settings.trackOpens,
          }}
          onRules={(patch) =>
            updateSettings.mutate({
              id: id(),
              settings: { ...loaded().settings, ...patch },
            })
          }
        />
      )}
    </Show>
  );
}
