import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  type CampaignFilters,
  matchesFilters,
  NO_FILTERS,
} from './filters';
import type { Campaign } from './sample';

const campaign = (patch: Partial<Campaign>): Campaign => ({
  id: 'c',
  name: 'C',
  audience: '',
  status: 'active',
  people: 100,
  sent: 100,
  replied: 0,
  meetings: 0,
  bounced: 0,
  daily: [],
  steps: [],
  window: '09:00–17:00',
  ownerId: 'me',
  sharing: 'private',
  ...patch,
});
const filters = (patch: Partial<CampaignFilters>) => ({
  ...NO_FILTERS,
  ...patch,
});

describe('campaign filters', () => {
  it('counts only filters away from their default', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(
      activeFilterCount(filters({ owner: 'mine', health: 'replies' }))
    ).toBe(2);
  });

  it('splits by owner', () => {
    const theirs = campaign({ ownerId: 'them' });
    expect(matchesFilters(theirs, filters({ owner: 'mine' }), 'me')).toBe(
      false
    );
    expect(matchesFilters(theirs, filters({ owner: 'shared' }), 'me')).toBe(
      true
    );
    expect(
      matchesFilters(campaign({}), filters({ owner: 'shared' }), 'me')
    ).toBe(false);
  });

  it('matches sharing exactly', () => {
    expect(
      matchesFilters(campaign({}), filters({ sharing: 'team' }), 'me')
    ).toBe(false);
  });

  it('flags bouncing above 2% only', () => {
    const at = (bounced: number) =>
      matchesFilters(
        campaign({ bounced }),
        filters({ health: 'bouncing' }),
        'me'
      );
    expect(at(2)).toBe(false);
    expect(at(3)).toBe(true);
  });

  it('finds campaigns with replies or nothing sent', () => {
    expect(
      matchesFilters(
        campaign({ replied: 1 }),
        filters({ health: 'replies' }),
        'me'
      )
    ).toBe(true);
    expect(
      matchesFilters(campaign({ sent: 0 }), filters({ health: 'unsent' }), 'me')
    ).toBe(true);
    expect(
      matchesFilters(campaign({}), filters({ health: 'unsent' }), 'me')
    ).toBe(false);
  });
});
