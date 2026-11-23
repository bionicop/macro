import EnvelopeIcon from '@icon/system/regular/envelope.svg';
import { BaseTool } from './BaseTool';
import { createToolRenderer } from './ToolRenderer';

/** One-line renderer for a campaign tool: the call, no per-tool detail panel. */
const campaignTool = <Name extends CampaignToolName>(
  name: Name,
  label: string
) =>
  createToolRenderer({
    name,
    render: (ctx) => (
      <BaseTool
        icon={EnvelopeIcon}
        renderContext={ctx.renderContext}
        type="call"
      >
        <span>{label}</span>
      </BaseTool>
    ),
  });

type CampaignToolName =
  | 'AddCampaignRecipients'
  | 'CreateCampaign'
  | 'EditCampaign'
  | 'GetCampaign'
  | 'LaunchCampaign'
  | 'ListCampaignRecipients'
  | 'ListCampaigns'
  | 'ListReplyDrafts'
  | 'PauseCampaign'
  | 'RemoveCampaignRecipients'
  | 'UpdateReplyDraft';

export const campaignToolHandlers = {
  AddCampaignRecipients: campaignTool(
    'AddCampaignRecipients',
    'Add people to a campaign'
  ),
  CreateCampaign: campaignTool('CreateCampaign', 'Create a campaign'),
  EditCampaign: campaignTool('EditCampaign', 'Edit a campaign'),
  GetCampaign: campaignTool('GetCampaign', 'Read a campaign'),
  LaunchCampaign: campaignTool('LaunchCampaign', 'Launch a campaign'),
  ListCampaignRecipients: campaignTool(
    'ListCampaignRecipients',
    'List campaign recipients'
  ),
  ListCampaigns: campaignTool('ListCampaigns', 'List campaigns'),
  ListReplyDrafts: campaignTool(
    'ListReplyDrafts',
    'List drafted replies awaiting review'
  ),
  PauseCampaign: campaignTool('PauseCampaign', 'Pause a campaign'),
  RemoveCampaignRecipients: campaignTool(
    'RemoveCampaignRecipients',
    'Remove people from a campaign'
  ),
  UpdateReplyDraft: campaignTool('UpdateReplyDraft', 'Update a drafted reply'),
};
