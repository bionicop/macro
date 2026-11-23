//! Tools that start and stop sending: LaunchCampaign, PauseCampaign.

use super::{CampaignToolContext, campaign_error, campaign_receipt};
use crate::domain::models::LaunchCampaign as LaunchInput;
use crate::domain::service::CampaignService;
use ai_toolset::{
    AsyncTool, RequestContext, ServiceContext, ToolAnnotated, ToolAnnotations, ToolResult,
};
use async_trait::async_trait;
use entity_access::domain::{models::EditAccessLevel, ports::EntityAccessService};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What a launch did.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCampaignResponse {
    /// Recipients newly enrolled.
    pub enrolled: u64,
    /// Rows skipped: no contact, no email, or a suppressed address.
    pub skipped: u64,
}

/// Start sending.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "LaunchCampaign",
    description = "Start sending a campaign, or resume a paused one. This sends real email to real people, so call it only after the user has reviewed the emails, senders and recipients and asked you to launch, and quote their words. Emails go out inside the sending window, a few per minute per mailbox, up to each mailbox's daily cap."
)]
pub struct LaunchCampaign {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// The user's approval.
    #[schemars(
        description = "The user's own words asking to launch, quoted exactly, e.g. \"yes, send it\"."
    )]
    pub user_confirmation: String,
}

impl ToolAnnotated for LaunchCampaign {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::destructive("Launch campaign");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for LaunchCampaign
{
    type Output = LaunchCampaignResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let edit = campaign_receipt::<EditAccessLevel, E>(
            &*service_context.access,
            &request_context,
            self.campaign_id,
        )
        .await?;
        let outcome = service_context
            .service
            .launch(
                edit,
                Some(service_context.actor),
                LaunchInput {
                    user_confirmation: Some(self.user_confirmation.clone()),
                },
            )
            .await
            .map_err(campaign_error)?;
        Ok(LaunchCampaignResponse {
            enrolled: outcome.enrolled,
            skipped: outcome.skipped,
        })
    }
}

/// Paused.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PauseCampaignResponse {
    /// Always true; recipients keep their place for LaunchCampaign to resume.
    pub paused: bool,
}

/// Stop sending.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "PauseCampaign",
    description = "Stop a running campaign from sending. Recipients keep their place in the sequence; LaunchCampaign resumes it."
)]
pub struct PauseCampaign {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
}

impl ToolAnnotated for PauseCampaign {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::additive("Pause campaign");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for PauseCampaign
{
    type Output = PauseCampaignResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let edit = campaign_receipt::<EditAccessLevel, E>(
            &*service_context.access,
            &request_context,
            self.campaign_id,
        )
        .await?;
        service_context
            .service
            .pause(edit)
            .await
            .map_err(campaign_error)?;
        Ok(PauseCampaignResponse { paused: true })
    }
}
