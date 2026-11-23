/** The tabs of an open campaign, in the order they show. */
export const CAMPAIGN_SECTIONS = [
  'overview',
  'sequence',
  'people',
  'settings',
] as const;
export type CampaignSection = (typeof CAMPAIGN_SECTIONS)[number];
