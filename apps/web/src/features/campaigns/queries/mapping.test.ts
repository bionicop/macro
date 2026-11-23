import type {
  AccessibleCampaign,
  CampaignStep,
} from '@service-storage/campaigns';
import { describe, expect, it } from 'vitest';
import {
  applyStepInputs,
  canLaunch,
  canPause,
  clockToMinutes,
  delayDaysToMinutes,
  delayMinutesToDays,
  listToSendDays,
  minutesToClock,
  patchCampaignInList,
  removeCampaignFromList,
  sendDaysToList,
  stepsToInputs,
} from './mapping';

const step = (id: string, position: number): CampaignStep => ({
  id,
  position,
  delayMinutes: 1440 * position,
  subject: `S${position}`,
  bodyHtml: `<p>${position}</p>`,
  bodyText: null,
  bodyMacro: null,
});

const campaign = (id: string): AccessibleCampaign =>
  ({ id, name: id, status: 'active' }) as AccessibleCampaign;

describe('send days', () => {
  it('maps the default Monday-Friday mask both ways', () => {
    expect(sendDaysToList(0b001_1111)).toEqual([0, 1, 2, 3, 4]);
    expect(listToSendDays([0, 1, 2, 3, 4])).toBe(0b001_1111);
  });

  it('ignores duplicates and out-of-range days', () => {
    expect(listToSendDays([6, 6, 7, -1, 1.5])).toBe(0b100_0000);
    expect(sendDaysToList(0)).toEqual([]);
  });
});

describe('clock minutes', () => {
  it('round-trips the send window', () => {
    expect(minutesToClock(540)).toBe('09:00');
    expect(minutesToClock(1440)).toBe('24:00');
    expect(clockToMinutes('17:30')).toBe(1050);
  });

  it('rejects text that is not a time', () => {
    expect(clockToMinutes('9')).toBeUndefined();
    expect(clockToMinutes('10:75')).toBeUndefined();
    expect(clockToMinutes('25:00')).toBeUndefined();
  });
});

describe('step delays', () => {
  it('converts between days and minutes', () => {
    expect(delayDaysToMinutes(3)).toBe(4320);
    expect(delayMinutesToDays(4320)).toBe(3);
    expect(delayDaysToMinutes(-2)).toBe(0);
  });
});

describe('steps', () => {
  it('writes steps back in position order with ids kept', () => {
    const inputs = stepsToInputs([step('b', 2), step('a', 1)]);
    expect(inputs.map((input) => input.id)).toEqual(['a', 'b']);
    expect(inputs[0]).toMatchObject({ subject: 'S1', delayMinutes: 1440 });
  });

  it('renumbers an edited sequence and gives new steps fresh ids', () => {
    const saved = applyStepInputs(
      [
        { id: 'b', bodyHtml: 'x' },
        { bodyHtml: 'new' },
        { id: 'gone', bodyHtml: 'y' },
      ],
      [step('a', 1), step('b', 2)],
      (() => {
        let n = 0;
        return () => `new-${++n}`;
      })()
    );
    expect(saved.map((s) => [s.id, s.position])).toEqual([
      ['b', 1],
      ['new-1', 2],
      ['new-2', 3],
    ]);
  });
});

describe('cached lists', () => {
  it('patches only the matching campaign', () => {
    const list = [campaign('a'), campaign('b')];
    const next = patchCampaignInList(list, 'b', { status: 'paused' });
    expect(next?.[1]?.status).toBe('paused');
    expect(next?.[0]).toBe(list[0]);
  });

  it('removes a campaign and tolerates an empty cache', () => {
    expect(removeCampaignFromList([campaign('a'), campaign('b')], 'a')).toEqual(
      [campaign('b')]
    );
    expect(patchCampaignInList(undefined, 'a', {})).toBeUndefined();
    expect(removeCampaignFromList(undefined, 'a')).toBeUndefined();
  });
});

describe('status actions', () => {
  it('offers launch to drafts and paused, pause to active', () => {
    expect(canLaunch('draft')).toBe(true);
    expect(canLaunch('paused')).toBe(true);
    expect(canLaunch('active')).toBe(false);
    expect(canLaunch('completed')).toBe(false);
    expect(canPause('active')).toBe(true);
    expect(canPause('paused')).toBe(false);
  });
});
