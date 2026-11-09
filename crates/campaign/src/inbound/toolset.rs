//! Agent tools over campaigns, in the campaign's own words: a campaign
//! sends a sequence of steps to the contacts in its recipient table, from a
//! rotation of the user's mailboxes, inside a sending window. Every tool is
//! a thin adapter over [`CampaignService`]; nothing here decides policy.
//!
//! Recipients are CRM contacts: find or create them with the CRM tools, then
//! add them with `AddCampaignRecipients`. Connected inbox ids come from
//! `ListInboxes`. Launching sends real email, so it needs the user's words.

mod edit;
mod read;
mod send;

use crate::domain::models::{
    CampaignError, CampaignSettings, CampaignSharing, Sender, SenderMailbox, Step, StepInput,
};
use crate::domain::service::CampaignService;
use ai_toolset::{AsyncToolCollection, RequestContext, ToolCallError};
use bot_id::BotId;
use entity_access::domain::{
    models::{
        Entity, EntityAccessReceipt, EntityPermission, EntityType, MemberTeamRole,
        RequiredPermission,
    },
    ports::EntityAccessService,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

pub use edit::{
    AddCampaignRecipients, AddCampaignRecipientsResponse, CreateCampaign, CreateCampaignResponse,
    EditCampaign, EditCampaignResponse, RemoveCampaignRecipients, RemoveCampaignRecipientsResponse,
};
pub use read::{
    GetCampaign, GetCampaignResponse, ListCampaignRecipients, ListCampaignRecipientsResponse,
    ListCampaigns, ListCampaignsResponse,
};
pub use send::{LaunchCampaign, LaunchCampaignResponse, PauseCampaign, PauseCampaignResponse};

/// The campaign use cases, access, and the agent the tools act as.
pub struct CampaignToolContext<S, E> {
    /// Campaign use cases.
    pub service: Arc<S>,
    /// Resolves the caller's team and campaign permissions.
    pub access: Arc<E>,
    /// The agent acting for the requesting user; attribution only.
    pub actor: BotId,
}

impl<S, E> Clone for CampaignToolContext<S, E> {
    fn clone(&self) -> Self {
        Self {
            service: self.service.clone(),
            access: self.access.clone(),
            actor: self.actor,
        }
    }
}

impl<S, E> CampaignToolContext<S, E> {
    /// The tools over `service`, acting as the Macro AI bot.
    pub fn new(service: Arc<S>, access: Arc<E>) -> Self {
        Self {
            service,
            access,
            actor: bot_id::MACRO_AI_BOT_ID,
        }
    }
}

/// The campaign tools.
pub fn campaign_toolset<S, E>() -> AsyncToolCollection<CampaignToolContext<S, E>>
where
    S: CampaignService,
    E: EntityAccessService,
{
    AsyncToolCollection::new()
        .add_tool::<ListCampaigns, CampaignToolContext<S, E>>()
        .add_tool::<GetCampaign, CampaignToolContext<S, E>>()
        .add_tool::<ListCampaignRecipients, CampaignToolContext<S, E>>()
        .add_tool::<CreateCampaign, CampaignToolContext<S, E>>()
        .add_tool::<EditCampaign, CampaignToolContext<S, E>>()
        .add_tool::<AddCampaignRecipients, CampaignToolContext<S, E>>()
        .add_tool::<RemoveCampaignRecipients, CampaignToolContext<S, E>>()
        .add_tool::<LaunchCampaign, CampaignToolContext<S, E>>()
        .add_tool::<PauseCampaign, CampaignToolContext<S, E>>()
}

/// The caller's permission on a campaign, as a receipt. Every refusal reads
/// as not found, so ids cannot be probed.
async fn campaign_receipt<T: RequiredPermission, E: EntityAccessService>(
    access: &E,
    request: &RequestContext,
    id: Uuid,
) -> Result<EntityAccessReceipt<T>, ToolCallError> {
    access
        .generate_entity_access_receipt::<T>(&request.user_id, None, &id.to_string(), EntityType::Campaign)
        .await
        .map_err(|err| ToolCallError {
            description: "Campaign not found, or the user may not do that to it".to_string(),
            internal_error: err.into(),
        })
}

/// The caller's team, for creating and listing.
async fn team_receipt<E: EntityAccessService>(
    access: &E,
    request: &RequestContext,
) -> Result<EntityAccessReceipt<MemberTeamRole>, ToolCallError> {
    let team = access
        .get_user_team(&request.user_id)
        .await
        .map_err(|err| ToolCallError {
            description: "failed to look up the user's team".to_string(),
            internal_error: err.into(),
        })?
        .ok_or_else(|| ToolCallError {
            description: "Campaigns belong to a team, and the user is not in one".to_string(),
            internal_error: CampaignError::NotFound.into(),
        })?;
    EntityAccessReceipt::try_new_authenticated_user(
        request.user_id.clone(),
        Entity {
            entity_id: team.team_id.to_string(),
            entity_type: EntityType::Team,
        },
        EntityPermission::TeamRole { role: team.role },
    )
    .map_err(|err| ToolCallError {
        description: "failed to verify team membership".to_string(),
        internal_error: err.into(),
    })
}

/// A campaign error in words the model can act on.
fn campaign_error(err: CampaignError) -> ToolCallError {
    let description = match &err {
        CampaignError::Storage(_) => "Campaign storage failed; try again".to_string(),
        CampaignError::Access(_) => {
            "Campaign not found, or the user may not do that to it".to_string()
        }
        other => other.to_string(),
    };
    ToolCallError {
        description,
        internal_error: err.into(),
    }
}

/// Sharing, as the model writes it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ToolSharing {
    /// Only the creator.
    #[default]
    Private,
    /// The creator owns it; current team members may edit.
    Team,
}

impl From<ToolSharing> for CampaignSharing {
    fn from(sharing: ToolSharing) -> Self {
        match sharing {
            ToolSharing::Private => Self::Private,
            ToolSharing::Team => Self::Team,
        }
    }
}

/// When and how the campaign sends.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolSettings {
    /// IANA time zone the window is read in when a recipient has none, e.g.
    /// "America/New_York".
    pub time_zone: String,
    /// Window start, minutes after local midnight (540 = 9:00).
    pub window_start_minute: u16,
    /// Window end, minutes after local midnight (1020 = 17:00).
    pub window_end_minute: u16,
    /// Days to send on, a bitmask from Monday = 1 to Sunday = 64 (31 = weekdays).
    pub send_days: u8,
    /// Stop a recipient's sequence when they reply.
    pub stop_on_reply: bool,
    /// Count opens with a tracking pixel.
    pub track_opens: bool,
}

impl ToolSettings {
    fn from_settings(settings: &CampaignSettings) -> Self {
        Self {
            time_zone: settings.time_zone.clone(),
            window_start_minute: settings.window_start_minute,
            window_end_minute: settings.window_end_minute,
            send_days: settings.send_days,
            stop_on_reply: settings.stop_on_reply,
            track_opens: settings.track_opens,
        }
    }

    /// Applied over `current`, keeping the per-recipient time zone column.
    fn apply(self, current: &CampaignSettings) -> CampaignSettings {
        CampaignSettings {
            time_zone: self.time_zone,
            time_zone_column_id: current.time_zone_column_id,
            window_start_minute: self.window_start_minute,
            window_end_minute: self.window_end_minute,
            send_days: self.send_days,
            stop_on_reply: self.stop_on_reply,
            track_opens: self.track_opens,
        }
    }
}

/// One email of the sequence.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolStep {
    /// The step's id, to keep an existing step; omit for a new one.
    #[serde(default)]
    pub id: Option<Uuid>,
    /// Minutes to wait after the previous step (or after enrollment, for the
    /// first). 4320 is three days.
    pub delay_minutes: u32,
    /// Subject. Empty on a follow-up replies in the first email's thread.
    /// Merge fields are written {{Column name}}, with an optional fallback
    /// {{First name|there}}.
    pub subject: String,
    /// The body as HTML, with the same merge fields.
    pub body_html: String,
}

impl From<&Step> for ToolStep {
    fn from(step: &Step) -> Self {
        Self {
            id: Some(step.id),
            delay_minutes: step.delay_minutes,
            subject: step.subject.clone(),
            body_html: step.body_html.clone(),
        }
    }
}

impl From<ToolStep> for StepInput {
    fn from(step: ToolStep) -> Self {
        Self {
            id: step.id,
            delay_minutes: step.delay_minutes,
            subject: step.subject,
            body_html: step.body_html,
            body_text: None,
            body_macro: None,
        }
    }
}

/// A mailbox in the rotation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolSender {
    /// A connected inbox id from ListInboxes. Give this or `identityId`.
    #[serde(default)]
    pub inbox_id: Option<Uuid>,
    /// An SMTP or SendGrid sending identity the user added in Settings.
    #[serde(default)]
    pub identity_id: Option<Uuid>,
    /// Most emails this mailbox sends for the campaign per day; 30 to 50 keeps
    /// a new mailbox out of spam.
    pub daily_cap: u32,
}

impl From<&Sender> for ToolSender {
    fn from(sender: &Sender) -> Self {
        let (inbox_id, identity_id) = match sender.mailbox {
            SenderMailbox::Link { link_id } => (Some(link_id), None),
            SenderMailbox::Identity { identity_id } => (None, Some(identity_id)),
        };
        Self {
            inbox_id,
            identity_id,
            daily_cap: sender.daily_cap,
        }
    }
}

impl TryFrom<ToolSender> for Sender {
    type Error = ToolCallError;

    fn try_from(sender: ToolSender) -> Result<Self, Self::Error> {
        let mailbox = match (sender.inbox_id, sender.identity_id) {
            (Some(link_id), None) => SenderMailbox::Link { link_id },
            (None, Some(identity_id)) => SenderMailbox::Identity { identity_id },
            _ => {
                return Err(campaign_error(CampaignError::Invalid(
                    "Give each sender exactly one of inboxId or identityId",
                )));
            }
        };
        Ok(Self {
            mailbox,
            daily_cap: sender.daily_cap,
        })
    }
}
