//! Tools that read campaigns: ListCampaigns, GetCampaign, ListCampaignRecipients.

use super::{
    CampaignToolContext, ToolSender, ToolSettings, ToolStep, campaign_error, campaign_receipt,
    team_receipt,
};
use crate::domain::models::AccessibleCampaign;
use crate::domain::service::CampaignService;
use ai_toolset::{
    AsyncTool, RequestContext, ServiceContext, ToolAnnotated, ToolAnnotations, ToolResult,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use databases::domain::models::RowId;
use entity_access::domain::{models::ViewAccessLevel, ports::EntityAccessService};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A campaign in a list.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolCampaignSummary {
    /// The campaign id.
    pub campaign_id: Uuid,
    /// Its name.
    pub name: String,
    /// draft, active, paused or completed.
    pub status: String,
    /// The user's access: view, edit or owner.
    pub access: String,
    /// The database holding the recipient table, for the database tools.
    pub database_id: Uuid,
    /// When it was first launched.
    pub launched_at: Option<DateTime<Utc>>,
}

impl From<&AccessibleCampaign> for ToolCampaignSummary {
    fn from(accessible: &AccessibleCampaign) -> Self {
        let campaign = &accessible.campaign;
        Self {
            campaign_id: campaign.id,
            name: campaign.name.clone(),
            status: campaign.status.as_str().to_string(),
            access: format!("{:?}", accessible.grant).to_lowercase(),
            database_id: *campaign.database_id.as_uuid(),
            launched_at: campaign.launched_at,
        }
    }
}

/// The team's campaigns the user can see.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListCampaignsResponse {
    /// Campaigns, newest first.
    pub campaigns: Vec<ToolCampaignSummary>,
}

/// List campaigns.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[schemars(
    title = "ListCampaigns",
    description = "List the email outreach campaigns of the user's team that the user can see, with their status. Use GetCampaign for one campaign's sequence, senders and results."
)]
pub struct ListCampaigns {}

impl ToolAnnotated for ListCampaigns {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::read_only("List campaigns");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for ListCampaigns
{
    type Output = ListCampaignsResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let team = team_receipt(&*service_context.access, &request_context).await?;
        let campaigns = service_context
            .service
            .list(team)
            .await
            .map_err(campaign_error)?;
        Ok(ListCampaignsResponse {
            campaigns: campaigns.iter().map(ToolCampaignSummary::from).collect(),
        })
    }
}

/// Everything about one campaign.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetCampaignResponse {
    /// The campaign.
    #[serde(flatten)]
    pub campaign: ToolCampaignSummary,
    /// The recipient table, whose column names are the merge fields.
    pub table_id: Uuid,
    /// When and how it sends.
    pub settings: ToolSettings,
    /// The sequence, in order.
    pub steps: Vec<ToolStep>,
    /// The mailbox rotation.
    pub senders: Vec<ToolSender>,
    /// Recipient and send counts, per campaign and per step.
    pub stats: serde_json::Value,
}

/// Read one campaign.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "GetCampaign",
    description = "Read a campaign: its settings, its sequence of emails, the mailboxes it sends from and its results so far (sent, opened, replied, bounced, unsubscribed). Inbox ids in senders are the ids ListInboxes returns."
)]
pub struct GetCampaign {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
}

impl ToolAnnotated for GetCampaign {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::read_only("Get campaign");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for GetCampaign
{
    type Output = GetCampaignResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let access = &*service_context.access;
        let receipt = || {
            campaign_receipt::<ViewAccessLevel, E>(access, &request_context, self.campaign_id)
        };
        let service = &service_context.service;
        let campaign = service.get(receipt().await?).await.map_err(campaign_error)?;
        let steps = service.steps(receipt().await?).await.map_err(campaign_error)?;
        let senders = service
            .senders(receipt().await?)
            .await
            .map_err(campaign_error)?;
        let stats = service.stats(receipt().await?).await.map_err(campaign_error)?;
        Ok(GetCampaignResponse {
            campaign: ToolCampaignSummary::from(&campaign),
            table_id: *campaign.campaign.table_id.as_uuid(),
            settings: ToolSettings::from_settings(&campaign.campaign.settings),
            steps: steps.iter().map(ToolStep::from).collect(),
            senders: senders.iter().map(ToolSender::from).collect(),
            stats: serde_json::to_value(stats).unwrap_or_default(),
        })
    }
}

/// One page of enrolled recipients.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListCampaignRecipientsResponse {
    /// Each recipient's row id, contact, address, state (active, completed,
    /// replied, bounced, unsubscribed, failed, removed) and next send.
    pub recipients: serde_json::Value,
    /// Pass as `after` for the next page; absent on the last.
    pub next: Option<Uuid>,
}

/// List enrolled recipients.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "ListCampaignRecipients",
    description = "List the recipients a launched campaign enrolled, with where each is in the sequence: who replied, bounced or unsubscribed, and when the next email goes out. Rows added since launch are enrolled within minutes."
)]
pub struct ListCampaignRecipients {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// Cursor from the previous page.
    #[schemars(description = "The `next` value of the previous page; omit for the first.")]
    #[serde(default)]
    pub after: Option<Uuid>,
}

impl ToolAnnotated for ListCampaignRecipients {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::read_only("List campaign recipients");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for ListCampaignRecipients
{
    type Output = ListCampaignRecipientsResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let receipt = campaign_receipt::<ViewAccessLevel, E>(
            &*service_context.access,
            &request_context,
            self.campaign_id,
        )
        .await?;
        let page = service_context
            .service
            .recipients(receipt, self.after.map(RowId::from_uuid))
            .await
            .map_err(campaign_error)?;
        Ok(ListCampaignRecipientsResponse {
            recipients: serde_json::to_value(&page.recipients).unwrap_or_default(),
            next: page.next.map(RowId::into_uuid),
        })
    }
}
