//! Tools for reply drafts: ListReplyDrafts, UpdateReplyDraft. Neither sends.

use super::{CampaignToolContext, campaign_error, campaign_receipt};
use crate::domain::models::{CampaignError, ReplyDraft, ReplyDraftAction, ReplyDraftStatus, ReplyDraftUpdate};
use crate::domain::service::CampaignService;
use ai_toolset::{
    AsyncTool, RequestContext, ServiceContext, ToolAnnotated, ToolAnnotations, ToolCallError,
    ToolResult,
};
use async_trait::async_trait;
use entity_access::domain::{
    models::{EditAccessLevel, ViewAccessLevel},
    ports::EntityAccessService,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The campaign's reply drafts.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListReplyDraftsResponse {
    /// Newest first. Each has draftId (`id`), recipientEmail, inboundSubject,
    /// inboundText (what they wrote), status, draftSubject and draftBody.
    pub drafts: serde_json::Value,
}

/// List reply drafts.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "ListReplyDrafts",
    description = "List the draft replies queued for a campaign when recipients replied. A draft with status \"pending\" has no text yet: read inboundText and write one with UpdateReplyDraft. Drafts are never sent by this tool or by the campaign."
)]
pub struct ListReplyDrafts {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// Only this status.
    #[schemars(description = "pending, ready, dismissed or sent; omit for all.")]
    #[serde(default)]
    pub status: Option<String>,
}

impl ToolAnnotated for ListReplyDrafts {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::read_only("List reply drafts");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for ListReplyDrafts
{
    type Output = ListReplyDraftsResponse;

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
        let status = match self.status.as_deref() {
            None => None,
            Some(text) => Some(ReplyDraftStatus::parse(text).ok_or_else(|| ToolCallError {
                description: "status must be pending, ready, dismissed or sent".to_string(),
                internal_error: CampaignError::Invalid("Unknown draft status").into(),
            })?),
        };
        let drafts: Vec<ReplyDraft> = service_context
            .service
            .reply_drafts(receipt, status)
            .await
            .map_err(campaign_error)?;
        Ok(ListReplyDraftsResponse {
            drafts: serde_json::to_value(drafts).unwrap_or_default(),
        })
    }
}

/// The saved draft.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReplyDraftResponse {
    /// The draft after the change.
    pub draft: serde_json::Value,
}

/// Write or dismiss a reply draft.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "UpdateReplyDraft",
    description = "Write the subject and body of a reply draft, or dismiss it. Writing text makes a pending draft ready for the user to review; this does not send anything, and the user decides whether to send."
)]
pub struct UpdateReplyDraft {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// The draft.
    #[schemars(description = "The draft id, from ListReplyDrafts.")]
    pub draft_id: Uuid,
    /// New subject.
    #[serde(default)]
    pub subject: Option<String>,
    /// New body, plain text.
    #[serde(default)]
    pub body: Option<String>,
    /// Set aside instead of writing.
    #[schemars(description = "\"dismissed\" to set the draft aside.")]
    #[serde(default)]
    pub status: Option<String>,
}

impl ToolAnnotated for UpdateReplyDraft {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::additive("Update reply draft");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for UpdateReplyDraft
{
    type Output = UpdateReplyDraftResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let receipt = campaign_receipt::<EditAccessLevel, E>(
            &*service_context.access,
            &request_context,
            self.campaign_id,
        )
        .await?;
        let draft = service_context
            .service
            .update_reply_draft(
                receipt,
                self.draft_id,
                ReplyDraftUpdate {
                    subject: self.subject.clone(),
                    body: self.body.clone(),
                    status: match self.status.as_deref() {
                        None => None,
                        Some("dismissed") => Some(ReplyDraftAction::Dismissed),
                        Some(_) => {
                            return Err(ToolCallError {
                                description: "status can only be \"dismissed\"".to_string(),
                                internal_error: CampaignError::Invalid("Unknown draft action").into(),
                            });
                        }
                    },
                },
            )
            .await
            .map_err(campaign_error)?;
        Ok(UpdateReplyDraftResponse {
            draft: serde_json::to_value(draft).unwrap_or_default(),
        })
    }
}
