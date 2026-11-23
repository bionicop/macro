import { useNavigate } from '@app/lib/split-router';
import { campaignsCampaignRoute } from '@app/routes/routes';
import { Tool } from '@core/component/AI/component/tool/Tool';
import { fireAndForget } from '@core/util/fireAndForget';
import CheckCircleIcon from '@icon/system/regular/check-circle.svg';
import PaperPlaneTiltIcon from '@icon/system/regular/paper-plane-tilt.svg';
import WarningIcon from '@icon/system/regular/warning.svg';
import { For, Show } from 'solid-js';
import { formatCount, STATUS } from '../core/format';
import type { CampaignStatus } from '../core/sample';

/*
 * How campaign tool calls read in chat. The shapes mirror the agent tools in
 * crates/campaign/src/inbound/toolset; they are typed here until the tool
 * types are generated, then the renderers register these by tool name.
 */

export type ToolCampaignSummary = {
  campaignId: string;
  name: string;
  status: string;
  launchedAt?: string | null;
};
export type ToolCampaignStep = {
  id?: string | null;
  delayMinutes: number;
  subject: string;
  condition: string;
};
export type GetCampaignToolResult = {
  campaign: ToolCampaignSummary;
  steps: ToolCampaignStep[];
  senders: { dailyCap: number }[];
};
export type CheckCampaignToolResult = {
  ready: boolean;
  problems: { kind: string; message: string; stepId?: string }[];
};
export type SendCampaignTestToolResult = {
  sent: { stepId: string; subject: string; to: string }[];
};

const MINUTES_PER_DAY = 24 * 60;

const statusLabel = (status: string) =>
  STATUS[status as CampaignStatus]?.label ?? status;
const statusTone = (status: string) =>
  STATUS[status as CampaignStatus]?.tone ?? 'text-ink-muted';

/** Opens a campaign from a chat result. */
function useOpenCampaign() {
  const navigate = useNavigate();
  return (campaignId: string) =>
    fireAndForget(
      navigate({
        route: campaignsCampaignRoute,
        params: { campaignId, section: 'overview' },
      }),
      'campaigns'
    );
}

function CampaignRow(props: {
  campaign: ToolCampaignSummary;
  detail?: string;
}) {
  const open = useOpenCampaign();
  return (
    <Tool.ListButton onClick={() => open(props.campaign.campaignId)}>
      <Tool.ListItem icon={<PaperPlaneTiltIcon class="size-4" />}>
        <div class="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-xs text-ink">{props.campaign.name}</div>
            <Show when={props.detail}>
              {(detail) => (
                <div class="truncate text-xs text-ink-placeholder">
                  {detail()}
                </div>
              )}
            </Show>
          </div>
          <span class={`shrink-0 text-xs ${statusTone(props.campaign.status)}`}>
            {statusLabel(props.campaign.status)}
          </span>
        </div>
      </Tool.ListItem>
    </Tool.ListButton>
  );
}

/** ListCampaigns: each campaign, its state, and a click to open it. */
export function ListCampaignsToolResponse(props: {
  campaigns: ToolCampaignSummary[];
}) {
  return (
    <Tool.List>
      <Show
        when={props.campaigns.length > 0}
        fallback={<Tool.ListItem>No campaigns yet.</Tool.ListItem>}
      >
        <For each={props.campaigns}>
          {(campaign) => <CampaignRow campaign={campaign} />}
        </For>
      </Show>
    </Tool.List>
  );
}

/** "Day 4" for a step that waits three days after the one before. */
export function stepDays(steps: { delayMinutes: number }[]): number[] {
  let day = 1;
  return steps.map((step, index) => {
    if (index > 0)
      day += Math.max(1, Math.round(step.delayMinutes / MINUTES_PER_DAY));
    return day;
  });
}

/** GetCampaign: the campaign, then its emails in order with their day. */
export function GetCampaignToolResponse(props: GetCampaignToolResult) {
  const days = () => stepDays(props.steps);
  const cap = () =>
    props.senders.reduce((total, sender) => total + sender.dailyCap, 0);
  return (
    <Tool.List>
      <CampaignRow
        campaign={props.campaign}
        detail={`${props.steps.length} ${props.steps.length === 1 ? 'email' : 'emails'} · ${props.senders.length} ${props.senders.length === 1 ? 'sender' : 'senders'}${cap() ? ` · up to ${formatCount(cap())} a day` : ''}`}
      />
      <For each={props.steps}>
        {(step, index) => (
          <Tool.ListItem>
            <div class="flex min-w-0 flex-1 gap-2 text-xs">
              <span class="w-12 shrink-0 text-ink-placeholder tabular-nums">
                Day {days()[index()]}
              </span>
              <span class="min-w-0 truncate text-ink">
                {step.subject ||
                  (index() === 0 ? 'No subject yet' : 'Reply in the thread')}
              </span>
            </div>
          </Tool.ListItem>
        )}
      </For>
    </Tool.List>
  );
}

/** CheckCampaign: ready to launch, or what still stops it. */
export function CheckCampaignToolResponse(props: CheckCampaignToolResult) {
  return (
    <Tool.List>
      <Show
        when={!props.ready}
        fallback={
          <Tool.ListItem icon={<CheckCircleIcon class="size-4 text-success" />}>
            <span class="text-xs text-ink">Ready to launch</span>
          </Tool.ListItem>
        }
      >
        <For each={props.problems}>
          {(problem) => (
            <Tool.ListItem icon={<WarningIcon class="size-4 text-warning" />}>
              <span class="text-xs text-ink">{problem.message}</span>
            </Tool.ListItem>
          )}
        </For>
      </Show>
    </Tool.List>
  );
}

/** SendCampaignTest: which test emails went, and to whom. */
export function SendCampaignTestToolResponse(
  props: SendCampaignTestToolResult
) {
  return (
    <Tool.List>
      <Show
        when={props.sent.length > 0}
        fallback={<Tool.ListItem>Nothing to send yet.</Tool.ListItem>}
      >
        <For each={props.sent}>
          {(item) => (
            <Tool.ListItem icon={<PaperPlaneTiltIcon class="size-4" />}>
              <div class="min-w-0 flex-1 text-xs">
                <div class="truncate text-ink">{item.subject}</div>
                <div class="truncate text-ink-placeholder">To {item.to}</div>
              </div>
            </Tool.ListItem>
          )}
        </For>
      </Show>
    </Tool.List>
  );
}
