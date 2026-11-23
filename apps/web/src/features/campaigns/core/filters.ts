import type { Campaign } from './sample';

export type OwnerFilter = 'all' | 'mine' | 'shared';
export type SharingFilter = 'all' | 'private' | 'team';
export type HealthFilter = 'all' | 'replies' | 'bouncing' | 'unsent';

export type CampaignFilters = {
  owner: OwnerFilter;
  sharing: SharingFilter;
  health: HealthFilter;
};

export const NO_FILTERS: CampaignFilters = {
  owner: 'all',
  sharing: 'all',
  health: 'all',
};

export const OWNER_OPTIONS: { value: OwnerFilter; label: string }[] = [
  { value: 'all', label: 'Anyone' },
  { value: 'mine', label: 'Created by me' },
  { value: 'shared', label: 'Shared with me' },
];

export const SHARING_OPTIONS: { value: SharingFilter; label: string }[] = [
  { value: 'all', label: 'Any access' },
  { value: 'private', label: 'Private' },
  { value: 'team', label: 'Team' },
];

export const HEALTH_OPTIONS: { value: HealthFilter; label: string }[] = [
  { value: 'all', label: 'Any results' },
  { value: 'replies', label: 'Has replies' },
  { value: 'bouncing', label: 'Bouncing over 2%' },
  { value: 'unsent', label: 'Nothing sent yet' },
];

/** Bounce share that earns a warning, below the limit that pauses sending. */
export const BOUNCE_WARNING = 0.02;

export const activeFilterCount = (filters: CampaignFilters) =>
  (Object.keys(NO_FILTERS) as (keyof CampaignFilters)[]).filter(
    (key) => filters[key] !== NO_FILTERS[key]
  ).length;

export function matchesFilters(
  campaign: Campaign,
  filters: CampaignFilters,
  userId: string | undefined
): boolean {
  if (filters.owner === 'mine' && campaign.ownerId !== userId) return false;
  if (filters.owner === 'shared' && campaign.ownerId === userId) return false;
  if (filters.sharing !== 'all' && campaign.sharing !== filters.sharing)
    return false;
  const bounce = campaign.sent ? campaign.bounced / campaign.sent : 0;
  switch (filters.health) {
    case 'replies':
      return campaign.replied > 0;
    case 'bouncing':
      return bounce > BOUNCE_WARNING;
    case 'unsent':
      return campaign.sent === 0;
    default:
      return true;
  }
}
