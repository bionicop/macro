import {
  FieldError,
  SelectInput,
  TextInput,
  TimeZoneInput,
} from '@app/features/scheduling/components/fields';
import {
  Chip,
  ProviderIcon,
  useConnectInbox,
} from '@app/features/settings/Email';
import {
  ChoiceRow,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@app/features/settings/primitives';
import { toast } from '@core/component/Toast/Toast';
import { useUserId } from '@core/context/user';
import { useEmailLinks } from '@core/email-link';
import { ThrownResultError, throwOnErr } from '@core/util/result';
import GmailIcon from '@icon/gmail-color.svg';
import OutlookIcon from '@icon/outlook-color.svg';
import ArrowUpRightIcon from '@icon/system/regular/arrow-up-right.svg';
import CheckIcon from '@icon/system/regular/check.svg';
import CheckCircleIcon from '@icon/system/regular/check-circle.svg';
import ClockIcon from '@icon/system/regular/clock.svg';
import EnvelopeIcon from '@icon/system/regular/envelope-simple.svg';
import PaperPlaneIcon from '@icon/system/regular/paper-plane-tilt.svg';
import PencilIcon from '@icon/system/regular/pencil-simple.svg';
import TagIcon from '@icon/system/regular/tag.svg';
import UsersIcon from '@icon/system/regular/users.svg';
import WarningIcon from '@icon/system/regular/warning-circle.svg';
import XIcon from '@icon/system/regular/x.svg';
import {
  type CampaignSender,
  type CampaignSendingIdentity,
  type CampaignSettings,
  type CampaignSharing,
  campaignsClient,
} from '@service-storage/campaigns';
import { Button, Checkbox, cn, Dialog, ToggleSwitch } from '@ui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { checkEmail, fillFields } from '../core/email-checks';
import { formatCount, stepTitle } from '../core/format';
import type { Person } from '../core/people';
import { nodesToInputs, stepsToNodes } from '../core/rows';
import { formatSendDays, windowState } from '../core/schedule';
import type { CampaignSection } from '../core/sections';
import {
  checkSendgridSender,
  SENDGRID_LINKS,
  sendgridProblem,
} from '../core/sendgrid';
import {
  listToSendDays,
  minutesToClock,
  sendDaysToList,
  useAddCampaignPeople,
  useAddSendgridSender,
  useCampaignIdentitiesQuery,
  useCampaignQuery,
  useCampaignRowCountQuery,
  useCampaignSendersQuery,
  useCampaignStepsQuery,
  useConnectSendgrid,
  useCreateCampaign,
  useRenameCampaign,
  useSaveCampaignSenders,
  useSaveCampaignSteps,
  useSendgridQuery,
  useUpdateCampaignSettings,
} from '../queries';
import {
  blankEmail,
  CampaignSequence,
  FOLLOW_UP_WAIT_DAYS,
  type SequenceNode,
  sendDays,
} from '../views/campaign-sequence';
import {
  CapInput,
  DAY_LETTERS,
  DAY_NAMES,
  DEFAULT_CAP,
  HALF_HOURS,
} from '../views/campaign-settings';
import { PeopleInput } from './people-input';

export const WIZARD_STEPS = [
  {
    id: 'details',
    label: 'Details',
    heading: 'Name your campaign',
    detail: 'Only you and your team see the name.',
    icon: TagIcon,
  },
  {
    id: 'sequence',
    label: 'Sequence',
    heading: 'Write the sequence',
    detail:
      'The first email, then follow-ups for people who don’t reply. Click an email to write it.',
    icon: PaperPlaneIcon,
  },
  {
    id: 'people',
    label: 'People',
    heading: 'Who gets it',
    detail:
      'Pick from your contacts, paste addresses or upload a CSV. You can add more later.',
    icon: UsersIcon,
  },
  {
    id: 'senders',
    label: 'Senders',
    heading: 'Who sends it',
    detail: 'Sends rotate across the inboxes you tick.',
    icon: EnvelopeIcon,
  },
  {
    id: 'schedule',
    label: 'Schedule',
    heading: 'When it sends',
    detail: 'Emails go out inside this window, spaced like a person sends.',
    icon: ClockIcon,
  },
  {
    id: 'review',
    label: 'Review',
    heading: 'Review',
    detail: 'Check everything before it is saved.',
    icon: CheckCircleIcon,
  },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];
const LAST = WIZARD_STEPS.length - 1;
const indexOf = (id: WizardStepId | undefined) =>
  Math.max(
    0,
    WIZARD_STEPS.findIndex((step) => step.id === id)
  );

const clock = (minutes: number) =>
  minutes >= 1440 ? '24:00' : minutesToClock(minutes);
const zoneLabel = (zone: string) => zone.replaceAll('_', ' ');

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** A new campaign's schedule: the browser's zone, 9 to 5 on weekdays. */
const defaultSettings = (): CampaignSettings => ({
  timeZone: browserZone(),
  timeZoneColumnId: null,
  windowStartMinute: 9 * 60,
  windowEndMinute: 17 * 60,
  sendDays: 0b11111,
  stopOnReply: true,
  trackOpens: false,
  autoDraftReplies: false,
});

const starterSequence = () => [blankEmail(0), blankEmail(FOLLOW_UP_WAIT_DAYS)];

const hasProblem = (node: SequenceNode, index: number) =>
  checkEmail({
    subject: node.subject,
    body: node.body,
    first: index === 0,
  }).some((check) => check.level === 'problem');

/**
 * + New and Continue setup: one full-size editor with every step on a rail,
 * the real sequence canvas in the middle, and nothing written until the
 * last step (or Save draft). Opened on a draft, it loads that draft and
 * saves the changes back to it.
 */
export function NewCampaignDialog(props: {
  open: boolean;
  /** A draft to continue; empty starts a new campaign. */
  campaignId?: string;
  startAt?: WizardStepId;
  onClose: () => void;
  onOpen: (id: string, section: CampaignSection) => void;
}) {
  const editing = () => Boolean(props.campaignId);
  const loadId = () => (props.open ? props.campaignId : undefined);
  const campaign = useCampaignQuery(loadId);
  const savedSteps = useCampaignStepsQuery(loadId);
  const savedSenders = useCampaignSendersQuery(loadId);
  const rowCount = useCampaignRowCountQuery(loadId);

  const create = useCreateCampaign();
  const rename = useRenameCampaign();
  const updateSettings = useUpdateCampaignSettings();
  const saveSteps = useSaveCampaignSteps();
  const saveSenders = useSaveCampaignSenders();
  const addPeople = useAddCampaignPeople();

  const [seeded, setSeeded] = createSignal(false);
  const [step, setStep] = createSignal(0);
  const [name, setName] = createSignal('');
  const [sharing, setSharing] = createSignal<CampaignSharing>('private');
  const [nodes, setNodes] = createSignal<SequenceNode[]>([]);
  const [settings, setSettings] = createSignal(defaultSettings());
  const [senders, setSenders] = createSignal<CampaignSender[]>([]);
  const [people, setPeople] = createSignal<Person[]>([]);
  const [error, setError] = createSignal<string>();
  const [dirty, setDirty] = createSignal(false);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const [saving, setSaving] = createSignal<'draft' | 'final'>();

  // Forget the last session only once closed, or it reloads while closing.
  createEffect(() => {
    if (!props.open) setSeeded(false);
  });
  // Load once per opening: a new campaign gets the starter, a draft its own.
  createEffect(() => {
    if (!props.open || seeded()) return;
    if (!props.campaignId) {
      untrack(() => {
        setName('');
        setSharing('private');
        setNodes(starterSequence());
        setSettings(defaultSettings());
        setSenders([]);
        setStep(indexOf(props.startAt));
      });
    } else {
      const loaded = campaign.data;
      const steps = savedSteps.data;
      const rotation = savedSenders.data;
      if (!loaded || !steps || !rotation) return;
      untrack(() => {
        setName(loaded.name);
        setSharing(loaded.sharing);
        setNodes(stepsToNodes(steps, undefined));
        setSettings({ ...defaultSettings(), ...loaded.settings });
        setSenders(rotation);
        setStep(indexOf(props.startAt));
      });
    }
    setPeople([]);
    setError(undefined);
    setDirty(false);
    setConfirmDiscard(false);
    setSeeded(true);
  });
  const loading = () => props.open && !seeded();

  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };
  const patchSettings = (patch: Partial<CampaignSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const finish = () => {
    setSaving(undefined);
    props.onClose();
  };
  const requestClose = () => {
    if (saving()) return;
    if (dirty()) setConfirmDiscard(true);
    else finish();
  };

  const existingPeople = () => rowCount.data?.count ?? 0;
  const totalPeople = () => existingPeople() + people().length;
  const problems = createMemo(
    () => nodes().filter((node, index) => hasProblem(node, index)).length
  );
  /** Whether each step has what launch needs, for the rail's marks. */
  const ready = (id: WizardStepId): boolean | undefined => {
    switch (id) {
      case 'details':
        return Boolean(name().trim());
      case 'sequence':
        return nodes().length > 0 && problems() === 0;
      case 'people':
        return totalPeople() > 0;
      case 'senders':
        return senders().length > 0;
      case 'schedule':
        return true;
      default:
        return undefined;
    }
  };

  const goTo = (index: number) => {
    if (index > 0 && !name().trim()) {
      setError('Name the campaign first');
      setStep(0);
      return;
    }
    setStep(index);
  };

  const save = async (kind: 'draft' | 'final') => {
    if (saving()) return;
    if (!name().trim()) {
      setError('Name the campaign');
      setStep(0);
      return;
    }
    setSaving(kind);
    let table = campaign.data;
    try {
      if (!table || !props.campaignId) {
        table = await create.mutateAsync({
          name: name().trim(),
          sharing: sharing(),
        });
      } else {
        const id = table.id;
        if (name().trim() !== table.name)
          await rename.mutateAsync({ id, name: name().trim() });
        if (sharing() !== table.sharing)
          await throwOnErr(() => campaignsClient.share(id, sharing()));
      }
    } catch {
      setSaving(undefined);
      toast.failure('Couldn’t save the campaign. Try again.');
      return;
    }

    const saved = table;
    const failed: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch {
        failed.push(label);
      }
    };
    await attempt('the schedule', () =>
      updateSettings.mutateAsync({
        id: saved.id,
        settings: {
          ...settings(),
          // The column is the server's, made with the people table.
          timeZoneColumnId: saved.settings.timeZoneColumnId,
        },
      })
    );
    if (nodes().length || editing())
      await attempt('the emails', () =>
        saveSteps.mutateAsync({ id: saved.id, steps: nodesToInputs(nodes()) })
      );
    await attempt('the senders', () =>
      saveSenders.mutateAsync({ id: saved.id, senders: senders() })
    );
    if (people().length)
      await attempt('the people', async () => {
        const result = await addPeople.mutateAsync({
          campaign: saved,
          people: people(),
        });
        if (result.failed.length)
          failed.push(
            `${formatCount(result.failed.length)} of the people (${result.failed.slice(0, 2).join(', ')}${result.failed.length > 2 ? '…' : ''})`
          );
      });

    if (failed.length)
      toast.failure(
        `Saved, but ${failed.join(', ')} didn’t save. Finish them on the campaign page.`
      );
    else
      toast.success(
        kind === 'draft'
          ? 'Saved to Drafts'
          : editing()
            ? 'Changes saved'
            : 'Campaign created'
      );
    finish();
    if (kind === 'final' || failed.length) props.onOpen(saved.id, 'overview');
  };

  const next = () => {
    if (step() === LAST) return void save('final');
    goTo(step() + 1);
  };
  const current = () => WIZARD_STEPS[step()]!;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && requestClose()}
      position="center"
      animate
      class="w-[min(80rem,calc(100vw-32px))] max-w-none overflow-hidden"
    >
      <Dialog.Title class="sr-only">
        {editing() ? 'Continue setup' : 'New campaign'}
      </Dialog.Title>
      <div class="flex h-[min(52rem,calc(100dvh-32px))] min-h-0">
        <nav
          aria-label="Campaign setup steps"
          class="hidden w-60 shrink-0 flex-col border-r border-edge-muted bg-panel md:flex"
        >
          <div class="flex flex-col gap-0.5 px-4 pt-5 pb-4">
            <span class="text-xs text-ink-muted">
              {editing() ? 'Draft campaign' : 'New campaign'}
            </span>
            <span class="truncate text-sm font-medium">
              {name().trim() || 'Untitled'}
            </span>
          </div>
          <ol class="flex flex-col gap-0.5 px-2">
            <For each={WIZARD_STEPS}>
              {(item, index) => {
                const state = () => ready(item.id);
                return (
                  <li>
                    <button
                      type="button"
                      disabled={loading() || Boolean(saving())}
                      aria-current={step() === index() ? 'step' : undefined}
                      onClick={() => goTo(index())}
                      class={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                        step() === index()
                          ? 'bg-hover text-ink'
                          : 'text-ink-muted not-touch:hover:bg-hover/60 not-touch:hover:text-ink'
                      )}
                    >
                      <span
                        class={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums',
                          state() === true && index() < LAST
                            ? 'border-success/40 bg-success/10 text-success'
                            : step() === index()
                              ? 'border-accent text-accent'
                              : 'border-edge-frame'
                        )}
                      >
                        <Show
                          when={state() === true && index() < LAST}
                          fallback={index() + 1}
                        >
                          <CheckIcon class="size-3" />
                        </Show>
                      </span>
                      <span class="min-w-0 flex-1 truncate">{item.label}</span>
                      <Show when={item.id === 'sequence' && nodes().length}>
                        <span class="text-xs text-ink-muted tabular-nums">
                          {nodes().length}
                        </span>
                      </Show>
                      <Show when={item.id === 'people' && totalPeople()}>
                        <span class="text-xs text-ink-muted tabular-nums">
                          {formatCount(totalPeople())}
                        </span>
                      </Show>
                      <Show
                        when={
                          item.id === 'sequence' && problems() && step() !== 1
                        }
                      >
                        <span
                          class="size-1.5 rounded-full bg-warning"
                          title="Some emails need work"
                        />
                      </Show>
                    </button>
                  </li>
                );
              }}
            </For>
          </ol>
          <p class="mt-auto px-4 pb-5 text-xs leading-relaxed text-ink-muted">
            {editing()
              ? 'Changes are saved when you click Save changes.'
              : 'Nothing is saved until you create the campaign or save a draft. Nothing sends until you launch it.'}
          </p>
        </nav>

        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex shrink-0 items-start gap-4 border-b border-edge-muted px-6 pt-5 pb-4">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Dynamic component={current().icon} class="size-4.5" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <h3 class="truncate text-lg font-medium leading-snug">
                <span class="mr-2 text-sm font-normal text-ink-muted md:hidden">
                  {step() + 1}/{WIZARD_STEPS.length}
                </span>
                {current().heading}
              </h3>
              <p class="truncate text-sm text-ink-muted">{current().detail}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              tooltip="Close"
              onClick={requestClose}
            >
              <XIcon class="size-4" />
            </Button>
          </header>

          <div
            class={cn(
              'min-h-0 flex-1',
              current().id === 'sequence'
                ? 'flex flex-col'
                : 'overflow-y-auto overscroll-contain px-8 py-8'
            )}
          >
            <Show
              when={!loading()}
              fallback={
                <p class="py-16 text-center text-sm text-ink-muted">
                  Loading the draft…
                </p>
              }
            >
              <Switch>
                <Match when={current().id === 'details'}>
                  <DetailsStep
                    name={name()}
                    sharing={sharing()}
                    error={error()}
                    onName={(value) => {
                      setName(value);
                      setError(undefined);
                      setDirty(true);
                    }}
                    onSharing={changed(setSharing)}
                    onSubmit={next}
                  />
                </Match>
                <Match when={current().id === 'sequence'}>
                  <CampaignSequence
                    bare
                    steps={nodes()}
                    initialSelected={nodes().length ? 0 : undefined}
                    status={
                      editing()
                        ? 'Saved when you save changes'
                        : 'Saved when you create the campaign'
                    }
                    rules={{
                      stopOnReply: settings().stopOnReply,
                      autoDraftReplies: Boolean(settings().autoDraftReplies),
                      trackOpens: settings().trackOpens,
                    }}
                    onRules={patchSettings}
                    onChange={changed(setNodes)}
                  />
                </Match>
                <Match when={current().id === 'people'}>
                  <PeopleInput
                    people={people()}
                    onChange={changed(setPeople)}
                    existing={existingPeople()}
                    class="mx-auto max-w-3xl"
                  />
                </Match>
                <Match when={current().id === 'senders'}>
                  <div class="mx-auto flex w-full max-w-3xl flex-col gap-8">
                    <SendersStep
                      senders={senders()}
                      onChange={changed(setSenders)}
                    />
                  </div>
                </Match>
                <Match when={current().id === 'schedule'}>
                  <div class="mx-auto flex w-full max-w-3xl flex-col gap-8">
                    <ScheduleStep
                      settings={settings()}
                      onSave={patchSettings}
                    />
                  </div>
                </Match>
                <Match when={current().id === 'review'}>
                  <ReviewStep
                    name={name().trim()}
                    sharing={sharing()}
                    settings={settings()}
                    senders={senders()}
                    emails={nodes()}
                    people={totalPeople()}
                    newPeople={people().length}
                    onEdit={(id) => goTo(indexOf(id))}
                  />
                </Match>
              </Switch>
            </Show>
          </div>

          <footer class="flex shrink-0 items-center gap-2 border-t border-edge-frame px-6 py-3.5">
            <Show
              when={!confirmDiscard()}
              fallback={
                <>
                  <WarningIcon class="size-4 text-warning" aria-hidden="true" />
                  <span class="text-sm">
                    {editing()
                      ? 'Discard your changes to this draft?'
                      : 'Discard this campaign? Nothing has been saved.'}
                  </span>
                  <div class="ml-auto flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      onClick={() => setConfirmDiscard(false)}
                    >
                      Keep editing
                    </Button>
                    <Show when={name().trim()}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="lg"
                        onClick={() => void save('draft')}
                      >
                        Save draft
                      </Button>
                    </Show>
                    <Button
                      type="button"
                      variant="danger"
                      size="lg"
                      onClick={finish}
                    >
                      Discard
                    </Button>
                  </div>
                </>
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="lg"
                disabled={Boolean(saving())}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Show when={name().trim() && step() < LAST}>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  disabled={Boolean(saving()) || loading()}
                  tooltip={
                    editing()
                      ? 'Save and close'
                      : 'Save what you have and finish later'
                  }
                  onClick={() => void save('draft')}
                >
                  {saving() === 'draft'
                    ? 'Saving…'
                    : editing()
                      ? 'Save changes'
                      : 'Save draft'}
                </Button>
              </Show>
              <div class="ml-auto flex items-center gap-2">
                <Show when={step() > 0}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    disabled={Boolean(saving())}
                    onClick={() => setStep((s) => s - 1)}
                  >
                    Back
                  </Button>
                </Show>
                <Button
                  type="button"
                  size="lg"
                  disabled={
                    Boolean(saving()) ||
                    loading() ||
                    (step() === 0 && !name().trim())
                  }
                  onClick={next}
                >
                  {saving() === 'final'
                    ? 'Saving…'
                    : step() === LAST
                      ? editing()
                        ? 'Save changes'
                        : 'Create campaign'
                      : `Next: ${WIZARD_STEPS[step() + 1]!.label}`}
                </Button>
              </div>
            </Show>
          </footer>
        </div>
      </div>
    </Dialog>
  );
}

/* Details ------------------------------------------------------------ */

/** A section heading as Settings draws one, for content without a card. */
function Heading(props: { title: string; description?: string }) {
  return (
    <div class="mb-2 flex flex-col gap-1">
      <h2 class="text-base font-medium text-ink">{props.title}</h2>
      <Show when={props.description}>
        <p class="text-sm leading-relaxed text-ink-muted">
          {props.description}
        </p>
      </Show>
    </div>
  );
}

function DetailsStep(props: {
  name: string;
  sharing: CampaignSharing;
  error?: string;
  onName: (name: string) => void;
  onSharing: (sharing: CampaignSharing) => void;
  onSubmit: () => void;
}) {
  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <section>
        <Heading
          title="Campaign name"
          description="Only you and your team see it, never the people you email."
        />
        <TextInput
          required
          size="lg"
          autofocus
          autocomplete="off"
          data-1p-ignore
          aria-label="Campaign name"
          aria-invalid={props.error ? true : undefined}
          placeholder="Expo exhibitor invites"
          value={props.name}
          onInput={(event) => props.onName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && props.name.trim()) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <div class="mt-2">
          <FieldError id="campaign-name-error" message={props.error} />
        </div>
      </section>
      <section>
        <Heading title="Who can see it" />
        <div class="grid gap-2 sm:grid-cols-2">
          <ChoiceRow
            name="campaign-sharing"
            value="private"
            checked={props.sharing === 'private'}
            title="Only me"
            description="Only you can open it and see its replies."
            onChange={() => props.onSharing('private')}
          />
          <ChoiceRow
            name="campaign-sharing"
            value="team"
            checked={props.sharing === 'team'}
            title="My team"
            description="Your team can open it, see results and answer replies."
            onChange={() => props.onSharing('team')}
          />
        </div>
      </section>
    </div>
  );
}

/* Senders ------------------------------------------------------------ */

type SenderRow = {
  key: string;
  email: string;
  provider: 'GMAIL' | 'OUTLOOK' | 'SMTP' | 'SENDGRID';
  note?: string;
  badge?: string;
  needsReauth?: boolean;
  mailbox: CampaignSender['mailbox'];
  /** The SendGrid sender for this inbox's address, if one is set up. */
  sendgrid?: CampaignSendingIdentity;
  verifiedAt?: string | null;
};

/** Why a row can't send the way it was asked to, and where to fix it. */
type RowProblem = { text: string; fix?: string };

const identityMailbox = (id: string): CampaignSender['mailbox'] => ({
  kind: 'identity',
  identity_id: id,
});

const sameMailbox = (
  a: CampaignSender['mailbox'],
  b: CampaignSender['mailbox']
) =>
  a.kind === 'link'
    ? b.kind === 'link' && a.link_id === b.link_id
    : b.kind === 'identity' && a.identity_id === b.identity_id;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The server's message when it wrote one for people, else the fallback. */
const readable = (error: unknown, fallback: string) => {
  const said = error instanceof ThrownResultError ? error.message : '';
  return said && !/^HTTP error/i.test(said) ? said : fallback;
};

/**
 * The inboxes connected in Email settings, each sent directly or through
 * SendGrid, then SendGrid-only addresses and any SMTP mailbox. Each one
 * ticked sends a share of the campaign, up to its own daily limit.
 */
function SendersStep(props: {
  senders: CampaignSender[];
  onChange: (senders: CampaignSender[]) => void;
}) {
  const { query: links } = useEmailLinks();
  const identities = useCampaignIdentitiesQuery();
  const sendgrid = useSendgridQuery();
  const addSender = useAddSendgridSender();
  const connectInbox = useConnectInbox();
  const userId = useUserId();
  const [connecting, setConnecting] = createSignal<{
    /** Picks up what the user was doing once SendGrid is connected. */
    onConnected?: () => void;
  }>();
  const [busy, setBusy] = createSignal<string>();
  const [problems, setProblems] = createSignal<
    Record<string, RowProblem | undefined>
  >({});
  const setProblem = (key: string, problem?: RowProblem) =>
    setProblems((all) => ({ ...all, [key]: problem }));
  const account = () => sendgrid.data;
  const connected = () => Boolean(account()?.connected);

  const sendgridFor = (email: string) =>
    (identities.data ?? []).find(
      (identity) =>
        identity.transport === 'sendgrid' &&
        identity.fromEmail.toLowerCase() === email.toLowerCase()
    );

  const inboxes = createMemo<SenderRow[]>(() => {
    const all = links.isSuccess ? links.data.links : [];
    const uid = userId();
    return [...all]
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((link) => ({
        key: link.id,
        email: link.email_address,
        provider: link.provider === 'OUTLOOK' ? 'OUTLOOK' : 'GMAIL',
        badge:
          link.is_primary && link.macro_id === uid
            ? 'Primary'
            : link.macro_id !== uid
              ? 'Shared'
              : undefined,
        needsReauth: link.needs_reauth,
        mailbox: { kind: 'link', link_id: link.id },
        sendgrid: sendgridFor(link.email_address),
      }));
  });
  const own = createMemo(
    () => new Set(inboxes().map((row) => row.email.toLowerCase()))
  );
  // A SendGrid sender for a connected inbox's address is that inbox's
  // "Send with" choice; the rest are addresses that only send.
  const sendgridRows = createMemo<SenderRow[]>(() =>
    (identities.data ?? [])
      .filter(
        (identity) =>
          identity.transport === 'sendgrid' &&
          !own().has(identity.fromEmail.toLowerCase())
      )
      .map((identity) => ({
        key: identity.id,
        email: identity.fromEmail,
        provider: 'SENDGRID',
        note: identity.fromName ? `as ${identity.fromName}` : undefined,
        mailbox: identityMailbox(identity.id),
      }))
  );
  const smtpRows = createMemo<SenderRow[]>(() =>
    (identities.data ?? [])
      .filter((identity) => identity.transport === 'smtp')
      .map((identity) => ({
        key: identity.id,
        email: identity.fromEmail,
        provider: 'SMTP',
        note: identity.fromName ? `as ${identity.fromName}` : undefined,
        verifiedAt: identity.verifiedAt,
        mailbox: identityMailbox(identity.id),
      }))
  );

  const write = props.onChange;
  /** The row's own mailbox, or its SendGrid sender when sent that way. */
  const mailboxes = (row: SenderRow) =>
    row.sendgrid
      ? [row.mailbox, identityMailbox(row.sendgrid.id)]
      : [row.mailbox];
  const owns = (row: SenderRow, sender: CampaignSender) =>
    mailboxes(row).some((mailbox) => sameMailbox(sender.mailbox, mailbox));
  const find = (row: SenderRow) =>
    props.senders.find((sender) => owns(row, sender));
  const add = (mailbox: CampaignSender['mailbox']) =>
    write([
      ...props.senders,
      { mailbox, dailyCap: props.senders[0]?.dailyCap ?? DEFAULT_CAP },
    ]);
  const toggle = (row: SenderRow, on: boolean) => {
    setProblem(row.key, undefined);
    if (on) add(row.mailbox);
    else write(props.senders.filter((sender) => !owns(row, sender)));
  };
  const setCap = (row: SenderRow, dailyCap: number) =>
    write(
      props.senders.map((sender) =>
        owns(row, sender) ? { ...sender, dailyCap } : sender
      )
    );
  const route = (row: SenderRow, mailbox: CampaignSender['mailbox']) =>
    write(
      props.senders.map((sender) =>
        owns(row, sender) ? { ...sender, mailbox } : sender
      )
    );
  const viaSendgrid = (row: SenderRow) => {
    const sender = find(row);
    return Boolean(
      row.sendgrid &&
        sender &&
        sameMailbox(sender.mailbox, identityMailbox(row.sendgrid.id))
    );
  };

  /** Move an inbox's share to SendGrid, connecting it first if needed. */
  const switchToSendgrid = async (row: SenderRow) => {
    const check = checkSendgridSender(account(), row.email);
    if (!check.ok && check.reason === 'not-connected') {
      setConnecting({ onConnected: () => void switchToSendgrid(row) });
      return;
    }
    if (!check.ok) {
      setProblem(row.key, {
        text: sendgridProblem(check) ?? '',
        fix: SENDGRID_LINKS.senderAuth,
      });
      return;
    }
    setProblem(row.key, undefined);
    if (row.sendgrid) return route(row, identityMailbox(row.sendgrid.id));
    setBusy(row.key);
    try {
      const identity = await addSender.mutateAsync({ fromEmail: row.email });
      route(row, identityMailbox(identity.id));
    } catch (error) {
      setProblem(row.key, {
        text: readable(error, 'SendGrid couldn’t add this address. Try again.'),
      });
    } finally {
      setBusy(undefined);
    }
  };
  const sendWith = (row: SenderRow, how: 'direct' | 'sendgrid') => {
    if (how === 'sendgrid') return void switchToSendgrid(row);
    setProblem(row.key, undefined);
    route(row, row.mailbox);
  };

  /** "acme.com authenticated" when SendGrid will take mail from it. */
  const sendgridNote = (email: string) => {
    const check = checkSendgridSender(account(), email);
    if (!check.ok) return undefined;
    return check.via === 'domain'
      ? `${check.domain} authenticated`
      : 'verified sender';
  };
  /** A refused switch, or a SendGrid sender its account no longer allows. */
  const problemFor = (row: SenderRow, onSendgrid: boolean) => {
    const asked = problems()[row.key];
    if (asked) return asked;
    if (!onSendgrid || sendgrid.isPending) return undefined;
    const text = sendgridProblem(checkSendgridSender(account(), row.email));
    if (!text) return undefined;
    return { text, fix: connected() ? SENDGRID_LINKS.senderAuth : undefined };
  };

  /**
   * What SendGrid lets the account send from: "@domain" for each
   * authenticated domain (any name on it), then each verified address not
   * already a sender here.
   */
  const fromChoices = createMemo(() => {
    const taken = new Set([
      ...own(),
      ...sendgridRows().map((row) => row.email.toLowerCase()),
    ]);
    return [
      ...(account()?.domains ?? [])
        .filter((entry) => entry.valid)
        .map((entry) => ({
          value: `@${entry.domain}`,
          label: `@${entry.domain}`,
        })),
      ...(account()?.verifiedSenders ?? [])
        .filter((email) => !taken.has(email.toLowerCase()))
        .map((email) => ({ value: email, label: email })),
    ];
  });
  const [picked, setPicked] = createSignal<string>();
  const from = () => {
    const choices = fromChoices();
    const value = picked();
    return choices.some((choice) => choice.value === value)
      ? value
      : choices[0]?.value;
  };
  const onDomain = () => Boolean(from()?.startsWith('@'));
  const [address, setAddress] = createSignal('');
  const [addError, setAddError] = createSignal<string>();
  const addAddress = async () => {
    const pick = from();
    if (!pick) return;
    const email = onDomain() ? `${address().trim()}${pick}` : pick;
    if (!EMAIL.test(email)) {
      setAddError('Enter the part before the @, like news.');
      return;
    }
    if (own().has(email.toLowerCase())) {
      setAddError(
        'That’s one of your inboxes. Tick it above and pick SendGrid under Send with.'
      );
      return;
    }
    const problem = sendgridProblem(checkSendgridSender(account(), email));
    if (problem) {
      setAddError(problem);
      return;
    }
    setAddError(undefined);
    try {
      const identity = await addSender.mutateAsync({ fromEmail: email });
      setAddress('');
      const mailbox = identityMailbox(identity.id);
      if (!props.senders.some((sender) => sameMailbox(sender.mailbox, mailbox)))
        add(mailbox);
    } catch (error) {
      setAddError(
        readable(error, 'SendGrid couldn’t add this address. Try again.')
      );
    }
  };

  const checked = () => {
    const at = account()?.checkedAt;
    return at ? ` · checked ${formatVerified(at)}` : '';
  };

  return (
    <>
      <SettingsSection
        title="Your inboxes"
        description="Replies land in your Macro inbox, threaded with the campaign."
        actions={
          <div class="flex items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => connectInbox('GMAIL')}
            >
              <GmailIcon class="size-3.5" aria-hidden="true" />
              Connect Gmail
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => connectInbox('OUTLOOK')}
            >
              <OutlookIcon class="size-3.5" aria-hidden="true" />
              Connect Outlook
            </Button>
          </div>
        }
      >
        <Show
          when={inboxes().length}
          fallback={
            <p class="py-2 text-sm text-ink-muted">
              No inbox connected yet. Connect Gmail or Outlook to send from your
              own address.
            </p>
          }
        >
          <SettingsCard>
            <For each={inboxes()}>
              {(row) => (
                <SenderItem
                  row={row}
                  sender={find(row)}
                  onToggle={(on) => toggle(row, on)}
                  onCap={(cap) => setCap(row, cap)}
                  sendgrid={viaSendgrid(row)}
                  sendgridNote={sendgridNote(row.email)}
                  busy={busy() === row.key}
                  problem={
                    find(row) ? problemFor(row, viaSendgrid(row)) : undefined
                  }
                  onSendWith={(how) => sendWith(row, how)}
                />
              )}
            </For>
          </SettingsCard>
        </Show>
      </SettingsSection>

      <SettingsSection
        title="SendGrid"
        description={
          connected()
            ? `Connected${checked()}. Any address on an authenticated domain can send through it.`
            : 'Connect once with an API key. Then any address on a domain you’ve authenticated in SendGrid can send through it.'
        }
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setConnecting({})}
          >
            <SendgridIcon class="size-3.5" />
            {connected() ? 'Change key' : 'Connect SendGrid'}
          </Button>
        }
      >
        <Show when={connected()}>
          <SettingsCard>
            <div class="flex flex-wrap items-center gap-2 px-4 py-3">
              <span class="mr-1 text-sm text-ink">Domains</span>
              <For
                each={account()?.domains}
                fallback={
                  <span class="text-sm text-ink-muted">
                    None authenticated yet
                  </span>
                }
              >
                {(entry) => (
                  <span
                    class="ph-no-capture inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 text-xs text-ink"
                    title={
                      entry.valid
                        ? 'Authenticated'
                        : 'DNS records not verified yet'
                    }
                  >
                    <Dynamic
                      component={entry.valid ? CheckCircleIcon : WarningIcon}
                      class={cn(
                        'size-3.5',
                        entry.valid ? 'text-success' : 'text-warning'
                      )}
                      aria-hidden="true"
                    />
                    {entry.domain}
                  </span>
                )}
              </For>
              <Show when={account()?.verifiedSenders.length}>
                {(count) => (
                  <span class="text-xs text-ink-muted">
                    and {count()} verified{' '}
                    {count() === 1 ? 'address' : 'addresses'}
                  </span>
                )}
              </Show>
              <a
                href={SENDGRID_LINKS.senderAuth}
                target="_blank"
                rel="noopener noreferrer"
                class="ml-auto inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
              >
                Manage in SendGrid
                <ArrowUpRightIcon class="size-3" aria-hidden="true" />
              </a>
            </div>
            <For each={sendgridRows()}>
              {(row) => (
                <SenderItem
                  row={row}
                  sender={find(row)}
                  onToggle={(on) => toggle(row, on)}
                  onCap={(cap) => setCap(row, cap)}
                  sendgridNote={sendgridNote(row.email)}
                  problem={find(row) ? problemFor(row, true) : undefined}
                />
              )}
            </For>
            <Show when={fromChoices().length}>
              <form
                class="flex flex-col gap-1 px-4 py-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addAddress();
                }}
              >
                <span class="text-sm text-ink">Send from another address</span>
                <div class="flex items-center gap-2">
                  <Show when={onDomain()}>
                    <TextInput
                      aria-label="Name before the @"
                      value={address()}
                      placeholder="news"
                      class="ph-no-capture min-w-0 flex-1"
                      onInput={(event) => {
                        setAddress(event.currentTarget.value);
                        setAddError(undefined);
                      }}
                    />
                  </Show>
                  <SelectInput
                    label="SendGrid domain or verified address"
                    class={onDomain() ? 'w-56' : 'min-w-0 flex-1'}
                    value={from() ?? ''}
                    options={fromChoices()}
                    onChange={(value) => {
                      setPicked(value);
                      setAddError(undefined);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={
                      (onDomain() && !address().trim()) || addSender.isPending
                    }
                  >
                    Add
                  </Button>
                </div>
                <FieldError id="sendgrid-add-error" message={addError()} />
              </form>
            </Show>
          </SettingsCard>
          <p class="mt-2 text-xs leading-relaxed text-ink-muted">
            Emails sent through SendGrid don’t appear in your Gmail or Outlook
            Sent folder; each one is kept on the campaign. Replies go to the
            sending address.
          </p>
        </Show>
      </SettingsSection>

      <Show when={smtpRows().length}>
        <SettingsSection
          title="Other mailboxes"
          description="SMTP mailboxes set up for campaigns."
        >
          <SettingsCard>
            <For each={smtpRows()}>
              {(row) => (
                <SenderItem
                  row={row}
                  sender={find(row)}
                  onToggle={(on) => toggle(row, on)}
                  onCap={(cap) => setCap(row, cap)}
                />
              )}
            </For>
          </SettingsCard>
        </SettingsSection>
      </Show>

      <p
        class={cn(
          'text-sm leading-relaxed',
          props.senders.length ? 'text-ink-muted' : 'text-warning'
        )}
      >
        {props.senders.length
          ? `Sends rotate across ${props.senders.length === 1 ? '1 sender' : `${props.senders.length} senders`}, up to ${formatCount(props.senders.reduce((total, sender) => total + sender.dailyCap, 0))} emails a day in total. Keep each limit well under what Gmail, Outlook and your SendGrid plan allow so mail stays out of spam.`
          : 'Tick at least one sender. Launch stays locked until one is picked.'}
      </p>

      <SendgridConnectDialog
        open={Boolean(connecting())}
        connected={connected()}
        onClose={() => setConnecting(undefined)}
        onConnected={() => {
          const next = connecting()?.onConnected;
          setConnecting(undefined);
          next?.();
        }}
      />
    </>
  );
}

const PROVIDER_LABEL: Record<SenderRow['provider'], string> = {
  GMAIL: 'Gmail',
  OUTLOOK: 'Outlook / Microsoft 365',
  SMTP: 'SMTP',
  SENDGRID: 'SendGrid',
};

/** SendGrid's mark, drawn inline; there is no SendGrid icon in Macro. */
function SendgridIcon(props: { class?: string }) {
  return (
    <svg viewBox="0 0 32 32" class={props.class} aria-hidden="true">
      <path
        fill="#99E1F4"
        d="M0 10.67h10.67v10.66H0zM10.67 21.33h10.66V32H10.67z"
      />
      <path fill="#00B3E3" d="M10.67 10.67h10.66v10.66H10.67z" />
      <path
        fill="#1A82E2"
        d="M21.33 0H32v10.67H21.33zM10.67 0h10.66v10.67H10.67zM21.33 10.67H32v10.66H21.33z"
      />
    </svg>
  );
}

/** One sender: tick to send from it, then how and how many a day. */
function SenderItem(props: {
  row: SenderRow;
  sender?: CampaignSender;
  onToggle: (on: boolean) => void;
  onCap: (cap: number) => void;
  /** Inbox rows only: whether its share goes through SendGrid. */
  sendgrid?: boolean;
  sendgridNote?: string;
  busy?: boolean;
  problem?: RowProblem;
  onSendWith?: (how: 'direct' | 'sendgrid') => void;
}) {
  const detail = () => {
    if (props.row.needsReauth)
      return 'Reconnect in Email settings to send from it';
    if (props.busy) return 'Adding to SendGrid…';
    if (props.sendgrid)
      return ['Sends through SendGrid', props.sendgridNote]
        .filter(Boolean)
        .join(' · ');
    return [
      PROVIDER_LABEL[props.row.provider],
      props.row.note,
      props.row.provider === 'SENDGRID'
        ? props.sendgridNote
        : props.row.verifiedAt &&
          `verified ${formatVerified(props.row.verifiedAt)}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  return (
    <div class="flex min-h-[56px] flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5">
      <Checkbox
        checked={Boolean(props.sender)}
        onChange={props.onToggle}
        class="min-w-0 flex-1 gap-3"
      >
        <Checkbox.Control />
        <Checkbox.Label class="flex min-w-0 cursor-pointer items-center gap-3">
          <Switch
            fallback={
              <span
                aria-hidden="true"
                class="flex size-9 shrink-0 items-center justify-center text-ink-muted [&_svg]:size-5"
              >
                <EnvelopeIcon />
              </span>
            }
          >
            <Match
              when={
                props.row.provider === 'GMAIL' ||
                props.row.provider === 'OUTLOOK'
              }
            >
              <ProviderIcon
                provider={
                  props.row.provider === 'OUTLOOK' ? 'OUTLOOK' : 'GMAIL'
                }
              />
            </Match>
            <Match when={props.row.provider === 'SENDGRID'}>
              <span class="flex size-9 shrink-0 items-center justify-center">
                <SendgridIcon class="size-5" />
              </span>
            </Match>
          </Switch>
          <span class="flex min-w-0 flex-col">
            <span class="flex min-w-0 items-center gap-2">
              <span class="ph-no-capture truncate text-sm text-ink">
                {props.row.email}
              </span>
              <Show when={props.row.badge}>
                {(badge) => <Chip label={badge()} />}
              </Show>
            </span>
            <span
              class={
                props.row.needsReauth
                  ? 'text-xs text-failure'
                  : 'text-xs text-ink-muted'
              }
            >
              {detail()}
            </span>
          </span>
        </Checkbox.Label>
      </Checkbox>
      <Show when={props.sender}>
        {(sender) => (
          <div class="flex items-center gap-2">
            <Show when={props.onSendWith}>
              {(onSendWith) => (
                <SelectInput
                  label={`Send ${props.row.email} with`}
                  class="w-32"
                  value={props.sendgrid ? 'sendgrid' : 'direct'}
                  disabled={props.busy}
                  options={[
                    {
                      value: 'direct',
                      label:
                        props.row.provider === 'OUTLOOK' ? 'Outlook' : 'Gmail',
                    },
                    { value: 'sendgrid', label: 'SendGrid' },
                  ]}
                  onChange={(how) =>
                    onSendWith()(how === 'sendgrid' ? 'sendgrid' : 'direct')
                  }
                />
              )}
            </Show>
            <CapInput
              label={`Daily limit for ${props.row.email}`}
              value={sender().dailyCap}
              onChange={props.onCap}
            />
          </div>
        )}
      </Show>
      <Show when={props.problem}>
        {(problem) => (
          <p
            role="alert"
            class="basis-full pl-[76px] text-xs leading-relaxed text-failure"
          >
            {problem().text}
            <Show when={problem().fix}>
              {(href) => (
                <>
                  {' '}
                  <a
                    href={href()}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline underline-offset-2"
                  >
                    Fix it in SendGrid
                  </a>
                </>
              )}
            </Show>
          </p>
        )}
      </Show>
    </div>
  );
}

const formatVerified = (at: string) =>
  new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

/**
 * Connect SendGrid with one API key. The server checks the key, reads which
 * domains and addresses the account may send from, and stores it encrypted.
 */
function SendgridConnectDialog(props: {
  open: boolean;
  connected: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const connect = useConnectSendgrid();
  const [key, setKey] = createSignal('');
  const [error, setError] = createSignal<string>();
  createEffect(() => {
    if (!props.open) return;
    setKey('');
    setError(undefined);
  });
  const close = () => !connect.isPending && props.onClose();
  const save = async () => {
    const apiKey = key().trim();
    if (!apiKey) return;
    setError(undefined);
    try {
      const account = await connect.mutateAsync(apiKey);
      const domains = account.domains
        .filter((entry) => entry.valid)
        .map((entry) => entry.domain);
      toast.success(
        domains.length
          ? `SendGrid connected for ${domains.join(', ')}`
          : 'SendGrid connected. Authenticate a domain in SendGrid to send.'
      );
      props.onConnected();
    } catch (failure) {
      setError(
        readable(
          failure,
          'SendGrid refused this key. Check it has Mail Send access, then try again.'
        )
      );
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && close()}
      position="center"
      animate
      class="w-[min(30rem,calc(100vw-32px))] max-w-none"
    >
      <form
        class="flex flex-col gap-5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header class="flex items-start gap-3">
          <SendgridIcon class="mt-1 size-6 shrink-0" />
          <div class="flex flex-col gap-1">
            <Dialog.Title class="text-xl font-medium">
              {props.connected ? 'Change SendGrid key' : 'Connect SendGrid'}
            </Dialog.Title>
            <p class="text-sm leading-relaxed text-ink-muted">
              Macro checks the key, reads which domains you’ve authenticated,
              and stores it encrypted.
            </p>
          </div>
        </header>
        <div class="flex flex-col gap-1.5">
          <label for="sendgrid-key" class="text-sm text-ink">
            API key
          </label>
          <TextInput
            id="sendgrid-key"
            type="password"
            autocomplete="off"
            value={key()}
            placeholder="SG.…"
            class="ph-no-capture font-mono"
            onInput={(event) => {
              setKey(event.currentTarget.value);
              setError(undefined);
            }}
          />
          <FieldError id="sendgrid-key-error" message={error()} />
          <p class="text-xs leading-relaxed text-ink-muted">
            Give it Mail Send access, plus read access to Sender Authentication.{' '}
            <a
              href={SENDGRID_LINKS.apiKeys}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-0.5 text-ink underline underline-offset-2"
            >
              Create one in SendGrid
              <ArrowUpRightIcon class="size-3" aria-hidden="true" />
            </a>
          </p>
        </div>
        <footer class="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={connect.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!key().trim() || connect.isPending}>
            {connect.isPending
              ? 'Checking…'
              : props.connected
                ? 'Save key'
                : 'Connect'}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

/* Schedule ----------------------------------------------------------- */

const WEEKDAYS = [0, 1, 2, 3, 4];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function ScheduleStep(props: {
  settings: CampaignSettings;
  onSave: (patch: Partial<CampaignSettings>) => void;
}) {
  const days = () => sendDaysToList(props.settings.sendDays);
  const setDays = (next: number[]) => {
    // A campaign with no sending days would never send; keep at least one.
    if (next.length) props.onSave({ sendDays: listToSendDays(next) });
  };
  const toggleDay = (day: number) =>
    setDays(
      days().includes(day) ? days().filter((d) => d !== day) : [...days(), day]
    );
  const same = (list: number[]) =>
    days().length === list.length && list.every((d) => days().includes(d));
  const times = (keep: (minute: number) => boolean) =>
    HALF_HOURS.filter(keep).map((minute) => ({
      value: String(minute),
      label: clock(minute),
    }));

  return (
    <>
      <SettingsSection
        title="Sending window"
        description="Spaced out like a person sends, never all at once."
      >
        <SettingsCard>
          <SettingsRow
            label="Days"
            description={formatSendDays(props.settings.sendDays)}
          >
            <div role="group" aria-label="Sending days" class="flex gap-1">
              <For each={DAY_LETTERS}>
                {(letter, index) => {
                  const on = () => days().includes(index());
                  return (
                    <Button
                      type="button"
                      variant={on() ? 'secondary' : 'ghost'}
                      size="icon-md"
                      aria-pressed={on()}
                      aria-label={DAY_NAMES[index()]}
                      tooltip={DAY_NAMES[index()]}
                      class={cn(
                        'rounded-full text-xs font-medium',
                        on() ? 'text-ink' : 'text-ink-muted'
                      )}
                      onClick={() => toggleDay(index())}
                    >
                      {letter}
                    </Button>
                  );
                }}
              </For>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="ml-1 text-ink-muted"
                onClick={() => setDays(same(WEEKDAYS) ? EVERY_DAY : WEEKDAYS)}
              >
                {same(WEEKDAYS) ? 'Every day' : 'Weekdays'}
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label="Hours">
            <div class="flex items-center gap-2">
              <SelectInput
                label="Start"
                class="w-28"
                value={String(props.settings.windowStartMinute)}
                options={times(
                  (minute) => minute < props.settings.windowEndMinute
                )}
                onChange={(value) =>
                  props.onSave({ windowStartMinute: Number(value) })
                }
              />
              <span class="text-sm text-ink-muted">to</span>
              <SelectInput
                label="End"
                class="w-28"
                value={String(props.settings.windowEndMinute)}
                options={times(
                  (minute) => minute > props.settings.windowStartMinute
                )}
                onChange={(value) =>
                  props.onSave({ windowEndMinute: Number(value) })
                }
              />
            </div>
          </SettingsRow>
          <SettingsRow
            label="Time zone"
            description={windowState(props.settings).label}
          >
            <div class="w-64">
              <TimeZoneInput
                value={props.settings.timeZone}
                onChange={(timeZone) => props.onSave({ timeZone })}
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Tracking">
        <SettingsCard>
          <SettingsRow
            label="Track opens"
            description="Adds a tiny image to each email. Off is better for deliverability."
          >
            <ToggleSwitch
              aria-label="Track opens"
              checked={props.settings.trackOpens}
              onChange={(trackOpens) => props.onSave({ trackOpens })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

/* Review ------------------------------------------------------------- */

type ReadyItem = {
  label: string;
  ok: boolean;
  detail: string;
  step: WizardStepId;
};

/** One figure in the reach strip under the review's heading. */
function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-1 px-4 py-3">
      <span class="text-xs text-ink-muted">{props.label}</span>
      <span class="text-xl font-medium tabular-nums">{props.value}</span>
      <Show when={props.hint}>
        <span class="truncate text-xs text-ink-muted">{props.hint}</span>
      </Show>
    </div>
  );
}

/**
 * Laid out like a Settings page: whether it can launch, the reach in four
 * figures, a row per thing launch needs (each with a way back to it), and
 * the sequence the way one person receives it.
 */
function ReviewStep(props: {
  name: string;
  sharing: CampaignSharing;
  settings: CampaignSettings;
  senders: CampaignSender[];
  emails: SequenceNode[];
  people: number;
  newPeople: number;
  onEdit: (step: WizardStepId) => void;
}) {
  const { query: links } = useEmailLinks();
  const identities = useCampaignIdentitiesQuery();
  const emailOf = (sender: CampaignSender) => {
    const box = sender.mailbox;
    return box.kind === 'link'
      ? links.data?.links.find((link) => link.id === box.link_id)?.email_address
      : identities.data?.find((identity) => identity.id === box.identity_id)
          ?.fromEmail;
  };
  const capacity = () =>
    props.senders.reduce((total, sender) => total + sender.dailyCap, 0);
  const days = createMemo(() => sendDays(props.emails));
  const problems = () =>
    props.emails.filter((email, index) => hasProblem(email, index)).length;
  /** Sending days to get the first email to everyone. */
  const firstPassDays = () =>
    capacity() ? Math.ceil(props.people / capacity()) : 0;
  const senderNames = () =>
    props.senders
      .map((sender) => emailOf(sender))
      .filter(Boolean)
      .join(', ');

  const items = createMemo<ReadyItem[]>(() => [
    {
      label: 'Name',
      ok: Boolean(props.name),
      detail: props.name
        ? `${props.name} · ${props.sharing === 'team' ? 'your team can see it' : 'only you can see it'}`
        : 'Add a name',
      step: 'details',
    },
    {
      label: 'Emails',
      ok: props.emails.length > 0 && problems() === 0,
      detail: !props.emails.length
        ? 'Write at least one email'
        : problems()
          ? `${problems()} of ${props.emails.length} need work`
          : `${props.emails.length} ${props.emails.length === 1 ? 'email' : 'emails'} over ${days().at(-1) ?? 1} ${days().at(-1) === 1 ? 'day' : 'days'}`,
      step: 'sequence',
    },
    {
      label: 'People',
      ok: props.people > 0,
      detail: props.people
        ? `${formatCount(props.people)} ${props.people === 1 ? 'person' : 'people'}${
            props.newPeople && props.newPeople !== props.people
              ? `, ${formatCount(props.newPeople)} new`
              : ''
          }`
        : 'Add who to email',
      step: 'people',
    },
    {
      label: 'Senders',
      ok: props.senders.length > 0,
      detail: props.senders.length
        ? `${senderNames() || `${props.senders.length} inboxes`} · up to ${formatCount(capacity())} a day`
        : 'Pick an inbox to send from',
      step: 'senders',
    },
    {
      label: 'Schedule',
      ok: sendDaysToList(props.settings.sendDays).length > 0,
      detail: `${formatSendDays(props.settings.sendDays)}, ${clock(props.settings.windowStartMinute)}–${clock(props.settings.windowEndMinute)} ${zoneLabel(props.settings.timeZone)}`,
      step: 'schedule',
    },
  ]);
  const missing = () => items().filter((item) => !item.ok).length;

  return (
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header class="flex items-start gap-3">
        <Dynamic
          component={missing() ? WarningIcon : CheckCircleIcon}
          class={cn(
            'mt-0.5 size-5 shrink-0',
            missing() ? 'text-warning' : 'text-success'
          )}
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col gap-1">
          <h2 class="text-[22px]/tight font-medium tracking-[-0.02em]">
            {missing()
              ? `${missing()} ${missing() === 1 ? 'thing' : 'things'} left before launch`
              : 'Ready to launch'}
          </h2>
          <p class="text-sm leading-relaxed text-ink-muted">
            {missing()
              ? 'You can save it as a draft now and finish the rest later.'
              : 'Save it, then launch from the campaign’s Overview. Nothing sends until you do.'}
          </p>
        </div>
      </header>

      <SettingsCard class="grid grid-cols-2 sm:grid-cols-4 [&>*:not(:last-child)]:after:hidden">
        <Stat label="People" value={formatCount(props.people)} />
        <Stat
          label="Sends a day"
          value={capacity() ? formatCount(capacity()) : '—'}
        />
        <Stat
          label="First email reaches all"
          value={
            firstPassDays()
              ? `${firstPassDays()} ${firstPassDays() === 1 ? 'day' : 'days'}`
              : '—'
          }
          hint="sending days"
        />
        <Stat
          label="Emails each"
          value={String(props.emails.length)}
          hint={props.settings.stopOnReply ? 'fewer if they reply' : undefined}
        />
      </SettingsCard>

      <SettingsSection title="Before launch">
        <SettingsCard>
          <For each={items()}>
            {(item) => (
              <SettingsRow
                label={
                  <span class="flex items-center gap-2">
                    <Dynamic
                      component={item.ok ? CheckCircleIcon : WarningIcon}
                      class={cn(
                        'size-4 shrink-0',
                        item.ok ? 'text-success' : 'text-warning'
                      )}
                      aria-hidden="true"
                    />
                    {item.label}
                  </span>
                }
                description={
                  <span class="ph-no-capture line-clamp-1 pl-6">
                    {item.detail}
                  </span>
                }
              >
                <Button
                  type="button"
                  variant={item.ok ? 'ghost' : 'secondary'}
                  size="sm"
                  onClick={() => props.onEdit(item.step)}
                >
                  {item.ok ? 'Edit' : 'Fix'}
                </Button>
              </SettingsRow>
            )}
          </For>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="What one person gets"
        description={
          (props.settings.stopOnReply
            ? 'A reply stops their emails.'
            : 'Emails continue after a reply.') +
          (props.settings.autoDraftReplies
            ? ' Macro drafts an answer to each reply for you to check.'
            : '')
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onEdit('sequence')}
          >
            <PencilIcon class="size-3.5" aria-hidden="true" />
            Edit sequence
          </Button>
        }
      >
        <Show
          when={props.emails.length}
          fallback={<p class="py-2 text-sm text-ink-muted">No emails yet.</p>}
        >
          <SettingsCard>
            <For each={props.emails}>
              {(email, index) => {
                const bad = () => hasProblem(email, index());
                const subject = () =>
                  email.subject
                    ? fillFields(email.subject)
                    : index() === 0
                      ? 'No subject'
                      : `Re: ${fillFields(props.emails[0]?.subject ?? '') || 'same thread'}`;
                return (
                  <button
                    type="button"
                    class="flex w-full items-start gap-4 px-4 py-3 text-left not-touch:hover:bg-hover"
                    onClick={() => props.onEdit('sequence')}
                  >
                    <span class="w-12 shrink-0 pt-0.5 text-sm text-ink-muted tabular-nums">
                      Day {days()[index()]}
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate text-base">{subject()}</span>
                        <Show
                          when={index() > 0 && email.condition !== 'always'}
                        >
                          <span class="shrink-0 text-xs text-ink-muted">
                            {email.condition === 'opened'
                              ? 'if opened'
                              : 'if not opened'}
                          </span>
                        </Show>
                      </span>
                      <span class="line-clamp-1 text-sm text-ink/60">
                        {fillFields(email.body).replace(/\s+/g, ' ').trim() ||
                          'No message yet'}
                      </span>
                    </span>
                    <span
                      class={cn(
                        'flex shrink-0 items-center gap-1 pt-0.5 text-xs',
                        bad() ? 'text-failure' : 'text-ink-muted'
                      )}
                    >
                      <Show
                        when={bad()}
                        fallback={stepTitle(index(), props.emails.length)}
                      >
                        <WarningIcon class="size-3.5" aria-hidden="true" />
                        Needs work
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
          </SettingsCard>
        </Show>
      </SettingsSection>
    </div>
  );
}
