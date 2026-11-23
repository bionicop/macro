import type {
  CampaignDailyStatsDay,
  CampaignStats,
  CampaignStep,
} from '@service-storage/campaigns';
import { describe, expect, it } from 'vitest';
import {
  bestWeekday,
  calendarWeeks,
  dailyCsv,
  rollingRates,
  stepRows,
  takeaways,
  weekdayOf,
  weekdayRows,
} from './insights';

const day = (
  date: string,
  sent: number,
  replied = 0,
  bounced = 0,
  opened = 0
): CampaignDailyStatsDay => ({ date, sent, opened, replied, bounced });

const step = (id: string, position: number): CampaignStep =>
  ({
    id,
    position,
    subject: `Subject ${id}`,
    delayMinutes: 0,
    bodyHtml: '',
    condition: 'always',
  }) as CampaignStep;

const stats = (
  steps: { stepId: string; sent: number; replied: number; bounced?: number }[]
): CampaignStats => ({
  enrolled: 0,
  active: 0,
  completed: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  failed: 0,
  sent: 0,
  opened: 0,
  steps: steps.map((s) => ({ opened: 0, bounced: 0, ...s })),
});

describe('weekdays', () => {
  it('counts Monday as the first day', () => {
    expect(weekdayOf('2026-11-09')).toBe(0); // Monday
    expect(weekdayOf('2026-11-15')).toBe(6); // Sunday
  });

  it('adds days up per weekday with a reply rate', () => {
    const rows = weekdayRows([
      day('2026-11-09', 10, 1),
      day('2026-11-16', 10, 3),
      day('2026-11-10', 5),
    ]);
    expect(rows[0]).toMatchObject({
      day: 'Mon',
      sent: 20,
      replied: 4,
      replyRate: 20,
    });
    expect(rows[1]).toMatchObject({ day: 'Tue', sent: 5, replyRate: 0 });
  });
});

describe('bestWeekday', () => {
  it('ignores a quiet day with a high rate', () => {
    const rows = weekdayRows([
      day('2026-11-09', 100, 5), // Mon 5%
      day('2026-11-10', 100, 8), // Tue 8%
      day('2026-11-15', 4, 2), // Sun 50% on four sends
    ]);
    expect(bestWeekday(rows)?.day).toBe('Tue');
  });

  it('names no day when only one carries volume', () => {
    expect(bestWeekday(weekdayRows([day('2026-11-09', 100, 5)]))).toBe(
      undefined
    );
  });
});

describe('rollingRates', () => {
  it('smooths a quiet day over the trailing window', () => {
    const rates = rollingRates(
      [day('2026-11-01', 100, 5), day('2026-11-02', 2, 1)],
      7
    );
    expect(rates[1].replyRate).toBe(5.9); // 6 of 102, not 1 of 2
  });
});

describe('stepRows', () => {
  it('orders steps, reports the drop and marks the best step', () => {
    const rows = stepRows(
      [step('b', 1), step('a', 0)],
      stats([
        { stepId: 'a', sent: 100, replied: 4, bounced: 2 },
        { stepId: 'b', sent: 80, replied: 8 },
      ])
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows[0].change).toBeNull();
    expect(rows[1]).toMatchObject({
      change: -20,
      stoppedBefore: 6,
      best: true,
    });
    expect(rows[0].best).toBe(false);
  });

  it('names no best step from a single step', () => {
    const rows = stepRows(
      [step('a', 0)],
      stats([{ stepId: 'a', sent: 100, replied: 4 }])
    );
    expect(rows[0].best).toBe(false);
  });
});

describe('calendarWeeks', () => {
  it('pads the first week so Monday stays on top', () => {
    const weeks = calendarWeeks([day('2026-11-11', 1), day('2026-11-12', 1)]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].slice(0, 2)).toEqual([null, null]);
    expect(weeks[0][2]?.date).toBe('2026-11-11');
    expect(weeks[0]).toHaveLength(7);
  });
});

describe('takeaways', () => {
  it('says nothing went out when nothing did', () => {
    expect(
      takeaways({ days: [], previous: day('x', 0), steps: [] })[0].text
    ).toMatch(/Nothing sent/);
  });

  it('warns about bounces over the limit', () => {
    const notes = takeaways({
      days: [day('2026-11-09', 100, 2, 5)],
      previous: day('x', 0),
      steps: [],
    });
    expect(notes[0].tone).toBe('warning');
  });

  it('reports a reply-rate change on the period before', () => {
    const notes = takeaways({
      days: [day('2026-11-09', 100, 6)],
      previous: day('x', 100, 2),
      steps: [],
    });
    expect(notes.some((note) => note.text.includes('up 4 points'))).toBe(true);
  });
});

describe('dailyCsv', () => {
  it('writes a header and one row per day', () => {
    expect(dailyCsv([day('2026-11-09', 3, 1, 0, 2)])).toBe(
      '"Date","Sent","Opened","Replied","Bounced"\r\n"2026-11-09","3","2","1","0"'
    );
  });
});
