// What the Insights tab works out from a campaign's real counts. Pure, so the
// numbers can be tested without a server.

import type {
  CampaignDailyStatsDay,
  CampaignStats,
  CampaignStep,
  CampaignStepCondition,
} from '@service-storage/campaigns';
import { formatShare, stepTitle } from './format';

export type DayCounts = Omit<CampaignDailyStatsDay, 'date'>;

/** Above this share of bounces, mailbox providers start to distrust a sender. */
export const BOUNCE_LIMIT = 0.02;

export const share = (part: number, whole: number) =>
  whole ? part / whole : 0;

/** Rounded percent, one decimal, for charts and comparisons. */
export const percent = (part: number, whole: number) =>
  Math.round(share(part, whole) * 1000) / 10;

export function sumDays(days: readonly DayCounts[]): DayCounts {
  return days.reduce(
    (total, day) => ({
      sent: total.sent + day.sent,
      opened: total.opened + day.opened,
      replied: total.replied + day.replied,
      bounced: total.bounced + day.bounced,
    }),
    { sent: 0, opened: 0, replied: 0, bounced: 0 }
  );
}

/** Monday first, the way a work week reads. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 0 for Monday through 6 for Sunday, from a `YYYY-MM-DD` date. */
export const weekdayOf = (date: string) =>
  (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

export type WeekdayRow = DayCounts & { day: string; replyRate: number };

/** Sends and replies added up per weekday, Monday first. */
export function weekdayRows(
  days: readonly CampaignDailyStatsDay[]
): WeekdayRow[] {
  const rows = WEEKDAYS.map((day) => ({
    day,
    sent: 0,
    opened: 0,
    replied: 0,
    bounced: 0,
    replyRate: 0,
  }));
  for (const day of days) {
    const row = rows[weekdayOf(day.date)];
    row.sent += day.sent;
    row.opened += day.opened;
    row.replied += day.replied;
    row.bounced += day.bounced;
  }
  for (const row of rows) row.replyRate = percent(row.replied, row.sent);
  return rows;
}

/**
 * The weekday with the best reply rate, among days that carry real volume:
 * a weekend day with a handful of sends, collecting replies to the week's
 * mail, would otherwise always win.
 */
export function bestWeekday(rows: readonly WeekdayRow[]) {
  const peak = Math.max(0, ...rows.map((row) => row.sent));
  const busy = rows.filter(
    (row) => row.sent >= Math.max(10, peak * 0.5) && row.replied > 0
  );
  if (busy.length < 2) return undefined;
  return busy.reduce((a, b) => (b.replyRate > a.replyRate ? b : a));
}

export type RateDay = { date: string; replyRate: number; openRate: number };

/**
 * Reply and open rates over a trailing window, so a quiet day with two sends
 * doesn't spike the line to 50%.
 */
export function rollingRates(
  days: readonly CampaignDailyStatsDay[],
  window = 7
): RateDay[] {
  return days.map((day, index) => {
    const span = sumDays(
      days.slice(Math.max(0, index - window + 1), index + 1)
    );
    return {
      date: day.date,
      replyRate: percent(span.replied, span.sent),
      openRate: percent(span.opened, span.sent),
    };
  });
}

export type StepRow = {
  id: string;
  title: string;
  subject: string;
  condition: CampaignStepCondition;
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
  /** Change in people reached against the step before; null on the first. */
  change: number | null;
  /** People the step before lost to a reply or a bounce. */
  stoppedBefore: number;
  replyRate: number;
  best: boolean;
};

/** Each step's reach and outcome, and how many fewer people it reached. */
export function stepRows(
  steps: readonly CampaignStep[],
  stats: CampaignStats | undefined
): StepRow[] {
  const byStep = new Map(stats?.steps.map((step) => [step.stepId, step]));
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const rows = ordered.map((step, index): StepRow => {
    const counts = byStep.get(step.id);
    const before = index ? byStep.get(ordered[index - 1].id) : undefined;
    const sent = counts?.sent ?? 0;
    return {
      id: step.id,
      title: stepTitle(index, ordered.length),
      subject: step.subject,
      condition: index === 0 ? 'always' : (step.condition ?? 'always'),
      sent,
      opened: counts?.opened ?? 0,
      replied: counts?.replied ?? 0,
      bounced: counts?.bounced ?? 0,
      change: index ? sent - (before?.sent ?? 0) : null,
      stoppedBefore: (before?.replied ?? 0) + (before?.bounced ?? 0),
      replyRate: percent(counts?.replied ?? 0, sent),
      best: false,
    };
  });
  // A best step needs enough sends that the rate means something.
  const ranked = rows.filter((row) => row.sent >= 20 && row.replied > 0);
  const best = ranked.reduce<StepRow | undefined>(
    (top, row) => (!top || row.replyRate > top.replyRate ? row : top),
    undefined
  );
  if (best && ranked.length > 1) best.best = true;
  return rows;
}

/**
 * The range as calendar columns, one per week, Monday at the top. Days
 * before the range starts are null so the first column lines up.
 */
export function calendarWeeks<T extends { date: string }>(
  days: readonly T[]
): (T | null)[][] {
  if (!days.length) return [];
  const cells: (T | null)[] = [
    ...Array<null>(weekdayOf(days[0].date)).fill(null),
    ...days,
  ];
  const weeks: (T | null)[][] = [];
  for (let at = 0; at < cells.length; at += 7) {
    const week = cells.slice(at, at + 7);
    weeks.push([...week, ...Array<null>(7 - week.length).fill(null)]);
  }
  return weeks;
}

export type Takeaway = { tone: 'good' | 'warning' | 'neutral'; text: string };

/** A few plain sentences about what stands out, strongest first. */
export function takeaways(input: {
  days: readonly CampaignDailyStatsDay[];
  previous: DayCounts;
  steps: readonly StepRow[];
}): Takeaway[] {
  const now = sumDays(input.days);
  if (!now.sent)
    return [{ tone: 'neutral', text: 'Nothing sent in this period yet' }];
  const notes: Takeaway[] = [];

  if (now.sent >= 50) {
    const bounced = share(now.bounced, now.sent);
    notes.push(
      bounced > BOUNCE_LIMIT
        ? {
            tone: 'warning',
            text: `${formatShare(now.bounced, now.sent)} bounced, above the 2% that keeps inboxes trusted. Clean the list before the next step.`,
          }
        : {
            tone: 'good',
            text: `Bounces are at ${formatShare(now.bounced, now.sent)}, under the 2% limit`,
          }
    );
  }

  if (input.previous.sent >= 20) {
    const delta =
      percent(now.replied, now.sent) -
      percent(input.previous.replied, input.previous.sent);
    if (Math.abs(delta) >= 0.5)
      notes.push({
        tone: delta > 0 ? 'good' : 'warning',
        text: `Reply rate ${delta > 0 ? 'up' : 'down'} ${Math.abs(Math.round(delta * 10) / 10)} points on the period before`,
      });
  }

  const best = input.steps.find((step) => step.best);
  if (best)
    notes.push({
      tone: 'good',
      text: `${best.title} gets the most replies, ${best.replyRate}% of the people it reaches`,
    });

  const top = bestWeekday(weekdayRows(input.days));
  if (top)
    notes.push({
      tone: 'neutral',
      text: `${top.day} sends get the most replies (${top.replyRate}%)`,
    });

  return notes;
}

const csvCell = (value: string | number) => {
  let text = String(value);
  // Spreadsheets run cells that start like a formula.
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

/** One row per day, for the Download CSV action. */
export function dailyCsv(days: readonly CampaignDailyStatsDay[]) {
  return [
    ['Date', 'Sent', 'Opened', 'Replied', 'Bounced'],
    ...days.map((day) => [
      day.date,
      day.sent,
      day.opened,
      day.replied,
      day.bounced,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}
