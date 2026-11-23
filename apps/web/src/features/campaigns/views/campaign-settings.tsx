import {
  SelectInput,
  TimeZoneInput,
} from '@app/features/scheduling/components/fields';
import {
  SettingsButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@app/features/settings/primitives';
import type {
  CampaignSender,
  CampaignSettings as Settings,
} from '@service-storage/campaigns';
import { cn, NumberUnitInput, ToggleSwitch } from '@ui';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { CampaignAction } from '../components/campaign-table';
import { formatCount } from '../core/format';
import type { Campaign } from '../core/sample';
import { formatSendDays, windowState } from '../core/schedule';
import {
  listToSendDays,
  minutesToClock,
  sendDaysToList,
  useCampaignIdentitiesQuery,
  useCampaignQuery,
  useCampaignSendersQuery,
  useSaveCampaignSenders,
  useUpdateCampaignSettings,
} from '../queries';

export const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Every half hour; the end of the day is 24:00 so a window can run to midnight. */
export const HALF_HOURS = Array.from({ length: 49 }, (_, index) => index * 30);

/** Daily cap: the − and + step, how long typing waits before saving, the ceiling. */
const CAP_STEP = 10;
const CAP_SAVE_DELAY_MS = 600;
const CAP_MAX = 2000;
export const DEFAULT_CAP = 50;

const clock = (minutes: number) =>
  minutes >= 1440 ? '24:00' : minutesToClock(minutes);

/** How the campaign sends, laid out like the rest of Settings. */
export function CampaignSettings(props: {
  campaign: Campaign;
  onAction: (action: CampaignAction) => void;
}) {
  const id = () => props.campaign.id;
  const campaign = useCampaignQuery(id);
  const updateSettings = useUpdateCampaignSettings();

  const save = (patch: Partial<Settings>) => {
    const current = campaign.data?.settings;
    if (current)
      updateSettings.mutate({ id: id(), settings: { ...current, ...patch } });
  };

  return (
    <SettingsPage
      title="Campaign settings"
      description="Changes save as you make them and apply to emails that haven’t gone out yet."
    >
      <Show when={campaign.data?.settings}>
        {(settings) => (
          <>
            <ScheduleSection settings={settings()} onSave={save} />
            <InboxesSection campaignId={id()} />
            <SettingsSection title="Replies and tracking">
              <SettingsCard>
                <SettingsRow
                  label="Stop on reply"
                  description="Someone who replies gets no more emails from this campaign."
                >
                  <ToggleSwitch
                    size="md"
                    checked={settings().stopOnReply}
                    onChange={(stopOnReply) => save({ stopOnReply })}
                  />
                </SettingsRow>
                <SettingsRow
                  label="Draft answers to replies"
                  description="AI writes an answer to each reply for you to review. Nothing sends until you approve it."
                >
                  <ToggleSwitch
                    size="md"
                    checked={settings().autoDraftReplies ?? false}
                    onChange={(autoDraftReplies) => save({ autoDraftReplies })}
                  />
                </SettingsRow>
                <SettingsRow
                  label="Track opens"
                  description="Adds a tracking pixel. Leaving it off helps deliverability."
                >
                  <ToggleSwitch
                    size="md"
                    checked={settings().trackOpens}
                    onChange={(trackOpens) => save({ trackOpens })}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>
          </>
        )}
      </Show>

      <SettingsSection title="Campaign">
        <SettingsCard>
          <SettingsRow
            label="Duplicate campaign"
            description="Copies the sequence, settings and inboxes, without the people."
          >
            <SettingsButton onClick={() => props.onAction('duplicate')}>
              Duplicate
            </SettingsButton>
          </SettingsRow>
          <SettingsRow
            label="Delete campaign"
            description="Stops sending and moves the campaign to the trash. Replies stay in your inbox."
          >
            <SettingsButton
              variant="danger"
              onClick={() => props.onAction('delete')}
            >
              Delete
            </SettingsButton>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

export function ScheduleSection(props: {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
}) {
  const days = () => sendDaysToList(props.settings.sendDays);
  const toggleDay = (day: number) => {
    const next = days().includes(day)
      ? days().filter((d) => d !== day)
      : [...days(), day];
    // A campaign with no sending days would never send; keep at least one.
    if (next.length) props.onSave({ sendDays: listToSendDays(next) });
  };
  const summary = () =>
    `${formatSendDays(props.settings.sendDays)}, ${clock(props.settings.windowStartMinute)}–${clock(props.settings.windowEndMinute)} ${props.settings.timeZone.replaceAll('_', ' ')}. ${windowState(props.settings).label}.`;

  return (
    <SettingsSection title="Schedule" description={summary()}>
      <SettingsCard>
        <SettingsRow
          label="Sending days"
          description="Emails only go out on these days."
          stackOnNarrow
        >
          <div class="flex gap-1" role="group" aria-label="Sending days">
            <For each={DAY_LETTERS}>
              {(letter, index) => {
                const on = () => days().includes(index());
                return (
                  <button
                    type="button"
                    aria-pressed={on()}
                    aria-label={DAY_NAMES[index()]}
                    title={DAY_NAMES[index()]}
                    class={cn(
                      'size-8 rounded-md border text-xs font-medium transition-colors',
                      on()
                        ? 'border-accent bg-accent text-panel'
                        : 'border-edge bg-surface-2 text-ink-muted hover:text-ink'
                    )}
                    onClick={() => toggleDay(index())}
                  >
                    {letter}
                  </button>
                );
              }}
            </For>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Send window"
          description="Emails go out between these times, spread across the window."
          stackOnNarrow
        >
          <div class="flex items-center gap-2">
            <SelectInput
              label="Window start"
              class="w-24"
              value={String(props.settings.windowStartMinute)}
              options={HALF_HOURS.filter(
                (minute) => minute < props.settings.windowEndMinute
              ).map((minute) => ({
                value: String(minute),
                label: clock(minute),
              }))}
              onChange={(value) =>
                props.onSave({ windowStartMinute: Number(value) })
              }
            />
            <span class="text-sm text-ink-muted">to</span>
            <SelectInput
              label="Window end"
              class="w-24"
              value={String(props.settings.windowEndMinute)}
              options={HALF_HOURS.filter(
                (minute) => minute > props.settings.windowStartMinute
              ).map((minute) => ({
                value: String(minute),
                label: clock(minute),
              }))}
              onChange={(value) =>
                props.onSave({ windowEndMinute: Number(value) })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Time zone"
          description="Days and times above are in this zone."
          stackOnNarrow
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
  );
}

const identityOf = (sender: CampaignSender) =>
  sender.mailbox.kind === 'identity' ? sender.mailbox.identity_id : undefined;

/** Every inbox the user can send from, on or off, each with its daily cap. */
export function InboxesSection(props: { campaignId: string }) {
  const id = () => props.campaignId;
  const senders = useCampaignSendersQuery(id);
  const identities = useCampaignIdentitiesQuery();
  const saveSenders = useSaveCampaignSenders();

  const current = () => senders.data ?? [];
  const write = (next: CampaignSender[]) =>
    saveSenders.mutate({ id: id(), senders: next });

  const rows = createMemo(() => {
    const list = current();
    const known = (identities.data ?? []).map((identity) => ({
      key: identity.id,
      email: identity.fromEmail,
      name: identity.fromName,
      sender: list.find((sender) => identityOf(sender) === identity.id),
    }));
    // Senders that are not a sending identity, such as a connected mailbox.
    const other = list
      .filter((sender) => !identityOf(sender))
      .map((sender, index) => ({
        key: `mailbox-${index}`,
        email: 'Connected mailbox',
        name: null as string | null,
        sender: sender as CampaignSender | undefined,
      }));
    return [...known, ...other];
  });

  const capacity = () =>
    current().reduce((total, sender) => total + sender.dailyCap, 0);

  const toggle = (identityId: string, on: boolean) => {
    if (on) {
      const cap = current()[0]?.dailyCap ?? DEFAULT_CAP;
      write([
        ...current(),
        {
          mailbox: { kind: 'identity', identity_id: identityId },
          dailyCap: cap,
        },
      ]);
    } else {
      write(current().filter((sender) => identityOf(sender) !== identityId));
    }
  };
  const setCap = (target: CampaignSender, dailyCap: number) =>
    write(
      current().map((sender) =>
        sender === target ? { ...sender, dailyCap } : sender
      )
    );

  return (
    <SettingsSection
      title="Inboxes"
      description={
        current().length
          ? `Sends rotate across ${current().length === 1 ? '1 inbox' : `${current().length} inboxes`}, up to ${formatCount(capacity())} emails a day in total.`
          : 'Turn on at least one inbox to send from.'
      }
    >
      <SettingsCard>
        <Show
          when={rows().length}
          fallback={
            <SettingsRow
              label="No inboxes connected"
              description="Connect an inbox in Email settings to send from it."
            />
          }
        >
          <For each={rows()}>
            {(row) => (
              <SettingsRow
                label={
                  <span class="flex items-center gap-2">
                    <span
                      class={cn(
                        'size-2 shrink-0 rounded-full',
                        row.sender ? 'bg-success' : 'bg-edge'
                      )}
                      aria-hidden="true"
                    />
                    <span class="truncate">{row.email}</span>
                  </span>
                }
                description={
                  row.sender
                    ? `Up to ${formatCount(row.sender.dailyCap)} a day${row.name ? ` as ${row.name}` : ''}`
                    : 'Off for this campaign'
                }
                muted={!row.sender}
                stackOnNarrow
              >
                <Show when={row.sender}>
                  {(sender) => (
                    <CapInput
                      label={`Daily limit for ${row.email}`}
                      value={sender().dailyCap}
                      onChange={(cap) => setCap(sender(), cap)}
                    />
                  )}
                </Show>
                <ToggleSwitch
                  size="md"
                  checked={!!row.sender}
                  disabled={!row.key || row.key.startsWith('mailbox-')}
                  onChange={(on) => toggle(row.key, on)}
                />
              </SettingsRow>
            )}
          </For>
        </Show>
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * A sender's daily cap, on Macro's number field: type any value or step it
 * with − and +. Saves a moment after the last change, and at once on blur.
 */
export function CapInput(props: {
  label: string;
  value: number;
  onChange: (cap: number) => void;
}) {
  const [text, setText] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    clearTimeout(timer);
    timer = undefined;
    const value = text();
    if (value === undefined) return;
    const cap = Math.min(Math.round(Number(value)), CAP_MAX);
    if (Number.isFinite(cap) && cap >= 1 && cap !== props.value)
      props.onChange(cap);
  };
  onCleanup(commit);

  return (
    <NumberUnitInput
      format={false}
      step={CAP_STEP}
      minValue={1}
      maxValue={CAP_MAX}
      value={text() ?? String(props.value)}
      onChange={(next) => {
        setText(next);
        clearTimeout(timer);
        timer = setTimeout(commit, CAP_SAVE_DELAY_MS);
      }}
    >
      <NumberUnitInput.Controls align="inline-start">
        <NumberUnitInput.DecrementTrigger
          size="icon-md"
          aria-label={`Decrease ${props.label.toLowerCase()}`}
          tooltip="Fewer a day"
        />
      </NumberUnitInput.Controls>
      <NumberUnitInput.Frame>
        <NumberUnitInput.Input
          aria-label={props.label}
          class="w-14 px-2 text-right text-sm tabular-nums"
          onBlur={commit}
        />
        <NumberUnitInput.Unit>a day</NumberUnitInput.Unit>
      </NumberUnitInput.Frame>
      <NumberUnitInput.Controls>
        <NumberUnitInput.IncrementTrigger
          size="icon-md"
          aria-label={`Increase ${props.label.toLowerCase()}`}
          tooltip="More a day"
        />
      </NumberUnitInput.Controls>
    </NumberUnitInput>
  );
}
