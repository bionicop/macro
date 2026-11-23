import { CollapsibleSection, ViewSidebar } from '@app/components/view-shell';
import { useNavigate } from '@app/lib/split-router';
import { campaignsCampaignRoute } from '@app/routes/routes';
import { fireAndForget } from '@core/util/fireAndForget';
import { pressHandlers } from '@ui';
import { For, Show } from 'solid-js';
import { campaignsForInboxes, isSending } from '../core/mailbox';
import {
  useCampaignsQuery,
  useSendingCampaignSenders,
} from '../queries/campaigns';

export type MailCampaignsSectionProps = {
  /** Inbox (link) ids the mail view shows; undefined means all of them. */
  inboxIds: readonly string[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: () => void;
};

/**
 * The campaigns that send from the inboxes the Mail view is showing, so a
 * mailbox's outreach is one click from its mail. Hidden when there are none.
 */
export function MailCampaignsSection(props: MailCampaignsSectionProps) {
  const list = useCampaignsQuery();
  const sending = () => (list.data ?? []).filter(isSending);
  const senders = useSendingCampaignSenders(() =>
    sending().map((campaign) => campaign.id)
  );
  const shown = () => campaignsForInboxes(sending(), senders, props.inboxIds);
  const navigate = useNavigate();

  const open = (campaignId: string) => {
    fireAndForget(
      navigate({
        route: campaignsCampaignRoute,
        params: { campaignId, section: 'overview' },
      }),
      'campaigns'
    );
    props.onNavigate?.();
  };

  return (
    <Show when={shown().length > 0}>
      <CollapsibleSection.Root
        open={props.open}
        onOpenChange={props.onOpenChange}
      >
        <CollapsibleSection.Header>
          <CollapsibleSection.Trigger class="flex-1">
            <span class="min-w-0 truncate">Campaigns</span>
            <CollapsibleSection.Indicator />
          </CollapsibleSection.Trigger>
        </CollapsibleSection.Header>
        <CollapsibleSection.Content>
          <ViewSidebar.Nav aria-label="Campaigns sending from this inbox">
            <For each={shown()}>
              {(campaign) => (
                <ViewSidebar.Item
                  title={
                    campaign.status === 'paused'
                      ? `${campaign.name} (paused)`
                      : campaign.name
                  }
                  {...pressHandlers(() => open(campaign.id))}
                >
                  <ViewSidebar.Icon>
                    <span
                      class={`size-2 rounded-full ${
                        campaign.status === 'active'
                          ? 'bg-success'
                          : 'bg-warning'
                      }`}
                    />
                  </ViewSidebar.Icon>
                  <span class="min-w-0 flex-1 truncate">{campaign.name}</span>
                </ViewSidebar.Item>
              )}
            </For>
          </ViewSidebar.Nav>
        </CollapsibleSection.Content>
      </CollapsibleSection.Root>
    </Show>
  );
}
