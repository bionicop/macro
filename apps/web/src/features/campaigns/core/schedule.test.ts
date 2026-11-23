import { describe, expect, it } from 'vitest';
import { formatSendDays, lastDays, windowState } from './schedule';

const WEEKDAYS = 0b001_1111;
const settings = {
  timeZone: 'UTC',
  windowStartMinute: 9 * 60,
  windowEndMinute: 17 * 60,
  sendDays: WEEKDAYS,
};

describe('formatSendDays', () => {
  it('reads runs as ranges', () => {
    expect(formatSendDays(WEEKDAYS)).toBe('Mon–Fri');
    expect(formatSendDays(0b111_1111)).toBe('Every day');
    expect(formatSendDays(0b001_0101)).toBe('Mon, Wed, Fri');
    expect(formatSendDays(0)).toBe('No days');
  });
});

describe('windowState', () => {
  // 2026-11-12 is a Thursday.
  it('is open inside the window', () => {
    expect(windowState(settings, new Date('2026-11-12T10:00:00Z'))).toEqual({
      open: true,
      label: 'Sending until 17:00',
    });
  });

  it('names the next opening', () => {
    expect(windowState(settings, new Date('2026-11-12T07:00:00Z')).label).toBe(
      'Next send today at 09:00'
    );
    expect(windowState(settings, new Date('2026-11-12T18:00:00Z')).label).toBe(
      'Next send tomorrow at 09:00'
    );
    expect(windowState(settings, new Date('2026-11-13T18:00:00Z')).label).toBe(
      'Next send Mon at 09:00'
    );
  });

  it('uses the campaign time zone', () => {
    const tokyo = { ...settings, timeZone: 'Asia/Tokyo' };
    // 01:00 UTC is 10:00 in Tokyo.
    expect(windowState(tokyo, new Date('2026-11-12T01:00:00Z')).open).toBe(
      true
    );
  });
});

describe('lastDays', () => {
  it('ends today, inclusive', () => {
    expect(lastDays(3, 'UTC', new Date('2026-11-12T10:00:00Z'))).toEqual({
      from: '2026-11-10',
      to: '2026-11-12',
      tz: 'UTC',
    });
  });
});
