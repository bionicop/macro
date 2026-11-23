// Which campaigns send from which connected inbox, for the Mail sidebar.

import type {
  AccessibleCampaign,
  CampaignSender,
} from '@service-storage/campaigns';

/** Campaigns that still send or may send again; drafts and finished ones don't. */
export const isSending = (campaign: AccessibleCampaign) =>
  campaign.status === 'active' || campaign.status === 'paused';

/**
 * The sending campaigns that use one of the chosen inboxes, active first.
 * `inboxIds` undefined means every inbox. A campaign whose senders have not
 * loaded yet is left out rather than guessed.
 */
export function campaignsForInboxes(
  campaigns: readonly AccessibleCampaign[],
  sendersOf: (id: string) => readonly CampaignSender[] | undefined,
  inboxIds: readonly string[] | undefined
): AccessibleCampaign[] {
  return campaigns
    .filter((campaign) => {
      if (!isSending(campaign) || campaign.trashedAt) return false;
      const senders = sendersOf(campaign.id);
      if (!senders) return false;
      if (!inboxIds) return senders.length > 0;
      return senders.some(
        (sender) =>
          sender.mailbox.kind === 'link' &&
          inboxIds.includes(sender.mailbox.link_id)
      );
    })
    .sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        a.name.localeCompare(b.name)
    );
}
