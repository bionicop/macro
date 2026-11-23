// When a campaign may send, read from its settings in its own time zone.

import type { CampaignSettings } from '@service-storage/campaigns';
import { minutesToClock, sendDaysToList } from '../queries/mapping';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** "Mon–Fri", "Mon, Wed, Fri", "Every day" or "No days". */
export function formatSendDays(mask: number): string {
  const days = sendDaysToList(mask);
  if (days.length === 7) return 'Every day';
  if (!days.length) return 'No days';
  const runs: number[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && run.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) =>
      run.length > 2
        ? `${DAY_NAMES[run[0]!]}–${DAY_NAMES[run.at(-1)!]}`
        : run.map((day) => DAY_NAMES[day]).join(', ')
    )
    .join(', ');
}

/** Weekday (0 = Monday) and minutes past midnight of `at` in `timeZone`. */
export function localClock(at: Date, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return localClock(at, 'UTC');
  }
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: WEEKDAY[get('weekday')] ?? 0,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export type WindowState = {
  open: boolean;
  /** "Sending until 17:00" or "Next send Mon 09:00". */
  label: string;
};

/** Whether the sending window is open now, and when it closes or next opens. */
export function windowState(
  settings: Pick<
    CampaignSettings,
    'timeZone' | 'windowStartMinute' | 'windowEndMinute' | 'sendDays'
  >,
  at = new Date()
): WindowState {
  const { weekday, minute } = localClock(at, settings.timeZone);
  const allowed = new Set(sendDaysToList(settings.sendDays));
  const start = settings.windowStartMinute;
  const end = settings.windowEndMinute;
  if (!allowed.size || end <= start)
    return { open: false, label: 'No sending days set' };
  if (allowed.has(weekday) && minute >= start && minute < end)
    return { open: true, label: `Sending until ${minutesToClock(end)}` };
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = (weekday + ahead) % 7;
    if (!allowed.has(day) || (ahead === 0 && minute >= start)) continue;
    const when =
      ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : DAY_NAMES[day];
    return {
      open: false,
      label: `Next send ${when} at ${minutesToClock(start)}`,
    };
  }
  return { open: false, label: 'No sending days set' };
}

/** `YYYY-MM-DD` of `at` in `timeZone`. */
export function dateIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** The `days` dates ending today in `timeZone`, inclusive, oldest first. */
export function lastDays(days: number, timeZone: string, at = new Date()) {
  const to = dateIn(at, timeZone);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to, tz: timeZone };
}
