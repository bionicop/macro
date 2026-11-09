//! Tools that build campaigns: CreateCampaign, EditCampaign,
//! AddCampaignRecipients, RemoveCampaignRecipients.

use super::{
    CampaignToolContext, ToolSender, ToolSettings, ToolSharing, ToolStep, campaign_error,
    campaign_receipt, team_receipt,
};
use crate::domain::models::{CampaignError, CreateCampaign as CreateInput, Sender};
use crate::domain::service::CampaignService;
use ai_toolset::{
    AsyncTool, RequestContext, ServiceContext, ToolAnnotated, ToolAnnotations, ToolCallError,
    ToolResult,
};
use async_trait::async_trait;
use databases::domain::models::RowId;
use entity_access::domain::{
    models::{EditAccessLevel, OwnerAccessLevel, ViewAccessLevel},
    ports::EntityAccessService,
};
use models_databases::{
    CellValue, CellWrite, DatabaseOp, EntityKind, EntityRef, OpResult, RowsChange, RowsResult,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Most recipients one call adds; larger lists are added in several calls.
const MAX_RECIPIENTS_PER_CALL: usize = 500;

/// The created campaign.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateCampaignResponse {
    /// The new campaign id.
    pub campaign_id: Uuid,
    /// The database holding its recipient table.
    pub database_id: Uuid,
    /// The recipient table; add columns to it for more merge fields.
    pub table_id: Uuid,
}

/// Create a draft campaign.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "CreateCampaign",
    description = "Create an empty draft email outreach campaign for the user's team, as New campaign does. Nothing is sent until LaunchCampaign. Then write its emails and senders with EditCampaign and add its recipients with AddCampaignRecipients."
)]
pub struct CreateCampaign {
    /// Name.
    #[schemars(description = "The campaign's name, e.g. \"Q3 founders outreach\".")]
    pub name: String,
    /// Sharing.
    #[schemars(description = "private (the default) or team, to let the team edit it.")]
    #[serde(default)]
    pub sharing: ToolSharing,
}

impl ToolAnnotated for CreateCampaign {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::additive("Create campaign");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for CreateCampaign
{
    type Output = CreateCampaignResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let team = team_receipt(&*service_context.access, &request_context).await?;
        let created = service_context
            .service
            .create(
                team,
                CreateInput {
                    name: self.name.clone(),
                    sharing: self.sharing.into(),
                },
            )
            .await
            .map_err(campaign_error)?;
        Ok(CreateCampaignResponse {
            campaign_id: created.campaign.id,
            database_id: *created.campaign.database_id.as_uuid(),
            table_id: *created.campaign.table_id.as_uuid(),
        })
    }
}

/// What changed.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditCampaignResponse {
    /// The parts written, in order.
    pub updated: Vec<String>,
}

/// Change a campaign.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "EditCampaign",
    description = "Change a campaign: its name, sharing, sending window, sequence of emails or sender mailboxes. Only the parts given change; `steps` and `senders` replace the whole list, so read them with GetCampaign first and keep each existing step's id. Steps already sent cannot be removed. Senders must be the user's own mailboxes."
)]
pub struct EditCampaign {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// New name.
    #[serde(default)]
    pub name: Option<String>,
    /// New sharing; only the owner may change it.
    #[serde(default)]
    pub sharing: Option<ToolSharing>,
    /// New sending window and options.
    #[serde(default)]
    pub settings: Option<ToolSettings>,
    /// The whole sequence, in order.
    #[serde(default)]
    pub steps: Option<Vec<ToolStep>>,
    /// The whole mailbox rotation.
    #[serde(default)]
    pub senders: Option<Vec<ToolSender>>,
}

impl ToolAnnotated for EditCampaign {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::destructive("Edit campaign");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for EditCampaign
{
    type Output = EditCampaignResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        let access = &*service_context.access;
        let service = &service_context.service;
        let id = self.campaign_id;
        let edit = || campaign_receipt::<EditAccessLevel, E>(access, &request_context, id);
        // Senders are checked first, so a bad one changes nothing.
        let senders = self
            .senders
            .clone()
            .map(|senders| {
                senders
                    .into_iter()
                    .map(Sender::try_from)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let mut updated = Vec::new();
        if let Some(name) = &self.name {
            service
                .rename(edit().await?, name.clone())
                .await
                .map_err(campaign_error)?;
            updated.push("name".to_string());
        }
        if let Some(sharing) = self.sharing {
            let owner =
                campaign_receipt::<OwnerAccessLevel, E>(access, &request_context, id).await?;
            service
                .share(owner, sharing.into())
                .await
                .map_err(campaign_error)?;
            updated.push("sharing".to_string());
        }
        if let Some(settings) = &self.settings {
            let view = campaign_receipt::<ViewAccessLevel, E>(access, &request_context, id).await?;
            let current = service.get(view).await.map_err(campaign_error)?;
            service
                .update_settings(
                    edit().await?,
                    settings.clone().apply(&current.campaign.settings),
                )
                .await
                .map_err(campaign_error)?;
            updated.push("settings".to_string());
        }
        if let Some(steps) = &self.steps {
            service
                .set_steps(
                    edit().await?,
                    steps.iter().cloned().map(Into::into).collect(),
                )
                .await
                .map_err(campaign_error)?;
            updated.push("steps".to_string());
        }
        if let Some(senders) = senders {
            service
                .set_senders(edit().await?, senders)
                .await
                .map_err(campaign_error)?;
            updated.push("senders".to_string());
        }
        Ok(EditCampaignResponse { updated })
    }
}

/// The rows added.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddCampaignRecipientsResponse {
    /// One new row per contact, in the order given.
    pub row_ids: Vec<Uuid>,
}

/// Add CRM contacts as recipients.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "AddCampaignRecipients",
    description = "Add CRM contacts to a campaign's recipient table, one row each. Find contacts with the CRM tools, or create them with CreateContact. Contacts without an email, or whose address unsubscribed or bounced, are skipped when the campaign enrolls them. Rows added to a running campaign are enrolled within minutes. Other columns, used as merge fields, are written with the database tools."
)]
pub struct AddCampaignRecipients {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// Contacts to add.
    #[schemars(description = "CRM contact ids, at most 500 per call.")]
    pub contact_ids: Vec<Uuid>,
    /// The recipients' time zone.
    #[schemars(
        description = "IANA time zone these recipients are in, e.g. \"Europe/Berlin\", when the campaign sends in each recipient's zone. Omit to use the campaign's."
    )]
    #[serde(default)]
    pub time_zone: Option<String>,
}

impl ToolAnnotated for AddCampaignRecipients {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::additive("Add campaign recipients");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for AddCampaignRecipients
{
    type Output = AddCampaignRecipientsResponse;

    #[tracing::instrument(skip_all, fields(user_id=?request_context.user_id, campaign_id=%self.campaign_id, count=self.contact_ids.len()), err)]
    async fn call(
        &self,
        service_context: ServiceContext<CampaignToolContext<S, E>>,
        request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        if self.contact_ids.is_empty() || self.contact_ids.len() > MAX_RECIPIENTS_PER_CALL {
            return Err(campaign_error(CampaignError::Invalid(
                "Give between 1 and 500 contact ids per call",
            )));
        }
        let access = &*service_context.access;
        let service = &service_context.service;
        let id = self.campaign_id;
        let view = campaign_receipt::<ViewAccessLevel, E>(access, &request_context, id).await?;
        let campaign = service.get(view).await.map_err(campaign_error)?.campaign;
        let zone = match (&self.time_zone, campaign.settings.time_zone_column_id) {
            (Some(zone), Some(column)) => Some(CellWrite {
                column,
                value: CellValue::Text(zone.trim().to_string()),
            }),
            (Some(_), None) => {
                return Err(campaign_error(CampaignError::Invalid(
                    "This campaign sends in one time zone; change it with EditCampaign settings instead",
                )));
            }
            (None, _) => None,
        };
        let rows = self
            .contact_ids
            .iter()
            .map(|contact| {
                let mut cells = vec![CellWrite {
                    column: campaign.primary_column_id,
                    value: CellValue::Entities(vec![EntityRef {
                        entity_type: EntityKind::Contact,
                        entity_id: contact.to_string(),
                    }]),
                }];
                cells.extend(zone.clone());
                cells
            })
            .collect();
        let edit = campaign_receipt::<EditAccessLevel, E>(access, &request_context, id).await?;
        let applied = service
            .apply_ops(
                edit,
                Some(service_context.actor),
                vec![DatabaseOp::Rows {
                    table: campaign.table_id,
                    change: RowsChange::Insert { rows },
                }]
                .into(),
            )
            .await
            .map_err(campaign_error)?;
        let row_ids = applied
            .results
            .into_iter()
            .find_map(|result| match result {
                OpResult::Rows {
                    change: RowsResult::Inserted { rows },
                    ..
                } => Some(rows.into_iter().map(RowId::into_uuid).collect()),
                _ => None,
            })
            .ok_or_else(|| ToolCallError {
                description: "The rows were not added; try again".to_string(),
                internal_error: anyhow::anyhow!("insert returned no rows result"),
            })?;
        Ok(AddCampaignRecipientsResponse { row_ids })
    }
}

/// How many stopped.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCampaignRecipientsResponse {
    /// Recipients whose sequence stopped.
    pub removed: u64,
}

/// Stop recipients' sequences.
#[derive(Debug, Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
#[schemars(
    title = "RemoveCampaignRecipients",
    description = "Stop sending to some of a campaign's recipients. Their rows and the emails already sent stay; nothing more is sent to them by this campaign."
)]
pub struct RemoveCampaignRecipients {
    /// The campaign.
    #[schemars(description = "The campaign id, from ListCampaigns.")]
    pub campaign_id: Uuid,
    /// Rows to stop.
    #[schemars(description = "Recipient row ids, from ListCampaignRecipients.")]
    pub row_ids: Vec<Uuid>,
}

impl ToolAnnotated for RemoveCampaignRecipients {
    const ANNOTATIONS: ToolAnnotations =
        ToolAnnotations::destructive("Remove campaign recipients");
}

#[async_trait]
impl<S: CampaignService, E: EntityAccessService> AsyncTool<CampaignToolContext<S, E>>
    for RemoveCampaignRecipients
{
    type Output = RemoveCampaignRecipientsResponse;

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
        let removed = service_context
            .service
            .remove_recipients(
                edit,
                self.row_ids.iter().copied().map(RowId::from_uuid).collect(),
            )
            .await
            .map_err(campaign_error)?;
        Ok(RemoveCampaignRecipientsResponse { removed })
    }
}
