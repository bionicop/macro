import { describe, expect, it } from 'vitest';
import { stepDays } from './tool-campaigns';

describe('stepDays', () => {
  it('counts each wait from the email before, the first on day 1', () => {
    expect(
      stepDays([
        { delayMinutes: 0 },
        { delayMinutes: 3 * 1440 },
        { delayMinutes: 5 * 1440 },
      ])
    ).toEqual([1, 4, 9]);
  });
  it('treats a follow-up wait under a day as one day', () => {
    expect(stepDays([{ delayMinutes: 0 }, { delayMinutes: 60 }])).toEqual([
      1, 2,
    ]);
  });
});
