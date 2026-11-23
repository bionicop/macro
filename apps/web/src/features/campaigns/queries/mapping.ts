import type {
  AccessibleCampaign,
  CampaignStatus,
  CampaignStep,
  CampaignStepInput,
} from '@service-storage/campaigns';

/** Bit 0 = Monday, matching the backend's `sendDays`. */
const WEEKDAY_COUNT = 7;
const MINUTES_PER_DAY = 24 * 60;

/** Weekdays (0 = Monday … 6 = Sunday) a `sendDays` bitmask allows. */
export function sendDaysToList(mask: number): number[] {
  return Array.from({ length: WEEKDAY_COUNT }, (_, day) => day).filter(
    (day) => (mask >> day) & 1
  );
}

/** Inverse of `sendDaysToList`; ignores duplicates and out-of-range days. */
export function listToSendDays(days: readonly number[]): number {
  return days.reduce(
    (mask, day) =>
      Number.isInteger(day) && day >= 0 && day < WEEKDAY_COUNT
        ? mask | (1 << day)
        : mask,
    0
  );
}

/** Minutes after local midnight as `HH:mm`. */
export function minutesToClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** `HH:mm` as minutes after local midnight; undefined when it is not a time. */
export function clockToMinutes(clock: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return undefined;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && total <= MINUTES_PER_DAY ? total : undefined;
}

/** A step's delay in whole days, for UIs that count in days. */
export function delayMinutesToDays(minutes: number): number {
  return Math.round(minutes / MINUTES_PER_DAY);
}

export function delayDaysToMinutes(days: number): number {
  return Math.max(0, Math.round(days)) * MINUTES_PER_DAY;
}

/** Steps as an editor would write them back: in order, ids kept. */
export function stepsToInputs(
  steps: readonly CampaignStep[]
): CampaignStepInput[] {
  return [...steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => ({
      id: step.id,
      delayMinutes: step.delayMinutes,
      subject: step.subject,
      bodyHtml: step.bodyHtml,
      bodyText: step.bodyText,
      bodyMacro: step.bodyMacro,
    }));
}

/** Optimistic view of a saved sequence: positions follow input order. */
export function applyStepInputs(
  inputs: readonly CampaignStepInput[],
  existing: readonly CampaignStep[],
  newId: () => string
): CampaignStep[] {
  const byId = new Map(existing.map((step) => [step.id, step]));
  return inputs.map((input, index) => ({
    id: input.id && byId.has(input.id) ? input.id : newId(),
    position: index + 1,
    delayMinutes: input.delayMinutes ?? 0,
    subject: input.subject ?? '',
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText ?? null,
    bodyMacro: input.bodyMacro ?? null,
  }));
}

/** Patch one campaign in a cached list; other rows keep their identity. */
export function patchCampaignInList(
  list: AccessibleCampaign[] | undefined,
  id: string,
  patch: Partial<AccessibleCampaign>
): AccessibleCampaign[] | undefined {
  return list?.map((campaign) =>
    campaign.id === id ? { ...campaign, ...patch } : campaign
  );
}

export function removeCampaignFromList(
  list: AccessibleCampaign[] | undefined,
  id: string
): AccessibleCampaign[] | undefined {
  return list?.filter((campaign) => campaign.id !== id);
}

/** Status a campaign has once launch has been accepted. */
export const LAUNCHED_STATUS: CampaignStatus = 'active';
export const PAUSED_STATUS: CampaignStatus = 'paused';

/** Launch and resume are offered everywhere except an already-active campaign. */
export function canLaunch(status: CampaignStatus): boolean {
  return status === 'draft' || status === 'paused';
}

export function canPause(status: CampaignStatus): boolean {
  return status === 'active';
}
