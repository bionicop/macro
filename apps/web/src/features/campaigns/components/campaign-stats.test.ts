import { describe, expect, it } from 'vitest';
import { dailyCsv, sumDays } from './campaign-stats';

const day = (date: string, sent: number, replied = 0) => ({
  date,
  sent,
  opened: 0,
  replied,
  bounced: 0,
});

describe('sumDays', () => {
  it('adds campaigns day by day, oldest first', () => {
    const { days, counts } = sumDays([
      [day('2026-03-11', 4, 1), day('2026-03-10', 2)],
      [day('2026-03-10', 3)],
    ]);
    expect(days.map((d) => [d.date, d.sent])).toEqual([
      ['2026-03-10', 5],
      ['2026-03-11', 4],
    ]);
    expect(counts).toEqual({ sent: 9, opened: 0, replied: 1, bounced: 0 });
  });

  it('is empty with no campaigns in view', () => {
    expect(sumDays([])).toEqual({
      days: [],
      counts: { sent: 0, opened: 0, replied: 0, bounced: 0 },
    });
  });

  it('writes one CSV row per day', () => {
    expect(dailyCsv([day('2026-03-10', 5, 1)]).split('\r\n')).toEqual([
      '"Date","Sent","Opened","Replied","Bounced"',
      '"2026-03-10","5","0","1","0"',
    ]);
  });
});
