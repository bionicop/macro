//! Campaign values crossing the service boundary.

use chrono::{DateTime, Utc};
use databases::domain::{
    models::{ColumnId, DatabaseId, RowId, TableId},
    provisioning::StorageBlueprint,
};
use entity_access::domain::models::AccessLevel;
use macro_user_id::user_id::MacroUserIdStr;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Where a campaign is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStatus {
    /// Being built; nothing is sent.
    Draft,
    /// Sending to enrolled recipients inside the window.
    Active,
    /// Stopped by its editor; resumes where it left off.
    Paused,
    /// Every recipient has finished the sequence.
    Completed,
}

impl CampaignStatus {
    /// Database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Completed => "completed",
        }
    }
    /// Parse the database representation.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "draft" => Self::Draft,
            "active" => Self::Active,
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            _ => return None,
        })
    }
}

/// Initial sharing, or the desired team grant. Ownership never changes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CampaignSharing {
    /// Only the creator, by default.
    #[default]
    Private,
    /// Creator owns; current team members may edit.
    Team,
}

/// Request to create an empty draft campaign.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCampaign {
    /// Campaign name.
    pub name: String,
    /// Defaults to private.
    #[serde(default)]
    pub sharing: CampaignSharing,
}

/// When and how a campaign sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSettings {
    /// IANA zone of the sending window for recipients without their own.
    pub time_zone: String,
    /// Recipient column holding each recipient's IANA zone.
    #[schema(value_type = Option<Uuid>, required = true)]
    pub time_zone_column_id: Option<ColumnId>,
    /// Window start, minutes after local midnight.
    pub window_start_minute: u16,
    /// Window end, minutes after local midnight, exclusive.
    pub window_end_minute: u16,
    /// Allowed ISO weekdays, bit 0 = Monday.
    pub send_days: u8,
    /// Stop a recipient's sequence once they reply.
    pub stop_on_reply: bool,
    /// Add an open-tracking pixel to sent mail.
    pub track_opens: bool,
}

impl Default for CampaignSettings {
    fn default() -> Self {
        Self {
            time_zone: "UTC".into(),
            time_zone_column_id: None,
            window_start_minute: 9 * 60,
            window_end_minute: 17 * 60,
            send_days: 0b001_1111,
            stop_on_reply: true,
            track_opens: true,
        }
    }
}

/// Campaign metadata; recipients are read through the database service.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    /// Entity identity, used with `Campaign` access receipts.
    pub id: Uuid,
    /// Team whose contacts the campaign mails.
    pub team_id: Uuid,
    /// Owning user; sharing never changes ownership.
    pub user_id: String,
    /// Display name.
    pub name: String,
    /// Lifecycle.
    pub status: CampaignStatus,
    /// Dedicated backing database.
    #[schema(value_type = Uuid)]
    pub database_id: DatabaseId,
    /// Recipient table.
    #[schema(value_type = Uuid)]
    pub table_id: TableId,
    /// Protected contact reference column.
    #[schema(value_type = Uuid)]
    pub primary_column_id: ColumnId,
    /// Whether the campaign has a team grant.
    pub sharing: CampaignSharing,
    /// Window, days and tracking.
    pub settings: CampaignSettings,
    /// First launch.
    #[schema(required = true)]
    pub launched_at: Option<DateTime<Utc>>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Trashed campaigns send nothing and are omitted from navigation.
    #[schema(required = true)]
    pub trashed_at: Option<DateTime<Utc>>,
}

/// Metadata together with the caller's effective grant.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessibleCampaign {
    /// Campaign metadata.
    #[serde(flatten)]
    pub campaign: Campaign,
    /// Highest effective access.
    pub grant: AccessLevel,
}

/// One email of the sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Stable identity; sends refer to it.
    pub id: Uuid,
    /// 1-based order.
    pub position: u16,
    /// Wait after launch (step 1) or after the previous step's send.
    pub delay_minutes: u32,
    /// Subject template; empty replies in the first step's thread.
    pub subject: String,
    /// HTML body template.
    pub body_html: String,
    /// Plain-text alternative, derived from the HTML when absent.
    #[schema(required = true)]
    pub body_text: Option<String>,
    /// The composer's document, so the step reopens as written.
    #[schema(required = true)]
    pub body_macro: Option<String>,
}

/// A step as written by an editor. Without an id it is new; steps left out
/// are removed, unless one has already been sent.
#[derive(Debug, Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepInput {
    /// Existing step to keep.
    #[serde(default)]
    pub id: Option<Uuid>,
    /// Wait after launch (step 1) or after the previous step's send.
    #[serde(default)]
    pub delay_minutes: u32,
    /// Subject template; empty replies in the first step's thread.
    #[serde(default)]
    pub subject: String,
    /// HTML body template.
    pub body_html: String,
    /// Plain-text alternative.
    #[serde(default)]
    pub body_text: Option<String>,
    /// The composer's document.
    #[serde(default)]
    pub body_macro: Option<String>,
}

/// The mailbox a sender slot sends from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SenderMailbox {
    /// A connected Gmail or Outlook inbox; mail lands in its Sent folder.
    Link {
        /// The `email_links` row.
        link_id: Uuid,
    },
    /// An SMTP or SendGrid identity.
    Identity {
        /// The `campaign_sending_identities` row.
        identity_id: Uuid,
    },
}

/// A mailbox the campaign rotates through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    /// The mailbox.
    pub mailbox: SenderMailbox,
    /// Most emails this mailbox sends for the campaign per day.
    pub daily_cap: u32,
}

/// A recipient's progress through the sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecipientState {
    /// Waiting for the next step.
    Active,
    /// Received every step.
    Completed,
    /// Replied; no further steps.
    Replied,
    /// The address bounced.
    Bounced,
    /// Asked not to be mailed.
    Unsubscribed,
    /// A send failed permanently.
    Failed,
    /// Taken out of the campaign by an editor.
    Removed,
}

impl RecipientState {
    /// Database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Replied => "replied",
            Self::Bounced => "bounced",
            Self::Unsubscribed => "unsubscribed",
            Self::Failed => "failed",
            Self::Removed => "removed",
        }
    }
    /// Parse the database representation.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "active" => Self::Active,
            "completed" => Self::Completed,
            "replied" => Self::Replied,
            "bounced" => Self::Bounced,
            "unsubscribed" => Self::Unsubscribed,
            "failed" => Self::Failed,
            "removed" => Self::Removed,
            _ => return None,
        })
    }
}

/// An enrolled recipient row.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Recipient {
    /// Row of the recipient table.
    #[schema(value_type = Uuid)]
    pub row_id: RowId,
    /// CRM contact at enrollment.
    #[schema(required = true)]
    pub contact_id: Option<Uuid>,
    /// Address at enrollment.
    pub email: String,
    /// Name at enrollment.
    #[schema(required = true)]
    pub name: Option<String>,
    /// Zone at enrollment; the campaign's when absent.
    #[schema(required = true)]
    pub time_zone: Option<String>,
    /// Progress.
    pub state: RecipientState,
    /// The step sent next.
    pub next_position: u16,
    /// When it is due.
    #[schema(required = true)]
    pub next_send_at: Option<DateTime<Utc>>,
    /// Enrollment time.
    pub enrolled_at: DateTime<Utc>,
}

/// One page of recipients.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Recipients {
    /// Recipients in row-id order.
    pub recipients: Vec<Recipient>,
    /// Cursor for another page.
    #[schema(value_type = Option<Uuid>, required = true)]
    pub next: Option<RowId>,
}

/// Counts for the campaign's analytics.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CampaignStats {
    /// Recipients enrolled.
    pub enrolled: u64,
    /// Recipients still in the sequence.
    pub active: u64,
    /// Recipients who received every step.
    pub completed: u64,
    /// Recipients who replied.
    pub replied: u64,
    /// Recipients whose address bounced.
    pub bounced: u64,
    /// Recipients who unsubscribed.
    pub unsubscribed: u64,
    /// Recipients whose send failed.
    pub failed: u64,
    /// Emails sent.
    pub sent: u64,
    /// Sent emails opened at least once.
    pub opened: u64,
    /// Per-step counts, in sequence order.
    pub steps: Vec<StepStats>,
}

/// Counts for one step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepStats {
    /// The step.
    pub step_id: Uuid,
    /// Emails sent.
    pub sent: u64,
    /// Opened at least once.
    pub opened: u64,
    /// Answered.
    pub replied: u64,
    /// Bounced.
    pub bounced: u64,
}

/// Launch or resume. An agent launching for a user quotes the user's
/// approval, which is kept on the campaign.
#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchCampaign {
    /// The user's own words approving the launch; required from agents.
    #[serde(default)]
    pub user_confirmation: Option<String>,
}

/// What a launch did.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOutcome {
    /// Recipients newly enrolled.
    pub enrolled: u64,
    /// Rows skipped: no contact, no email, or a suppressed address.
    pub skipped: u64,
}

/// A row's contact, resolved for enrollment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactAddress {
    /// The address mailed.
    pub email: String,
    /// The contact's name, if any.
    pub name: Option<String>,
}

/// A recipient to insert. Existing rows are left untouched.
#[derive(Debug, Clone)]
pub struct Enrollment {
    /// Row of the recipient table.
    pub row_id: RowId,
    /// Referenced CRM contact.
    pub contact_id: Uuid,
    /// Its address.
    pub email: String,
    /// Its name.
    pub name: Option<String>,
    /// Zone from the row, if valid.
    pub time_zone: Option<String>,
    /// First send.
    pub next_send_at: DateTime<Utc>,
}

/// All records needed for atomic provisioning.
pub struct CampaignBlueprint {
    /// Campaign identity.
    pub id: Uuid,
    /// Team.
    pub team_id: Uuid,
    /// Initial grants.
    pub sharing: CampaignSharing,
    /// Recipient table schema, owned by the database domain.
    pub database: StorageBlueprint,
    /// Display name.
    pub name: String,
    /// Initial owner.
    pub creator: MacroUserIdStr<'static>,
    /// Protected contact reference.
    pub primary_column_id: ColumnId,
    /// The provisioned time-zone column.
    pub time_zone_column_id: ColumnId,
}

/// Outcome of replacing the sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepsOutcome {
    /// The sequence was replaced.
    Replaced,
    /// A step left out has already been sent.
    SentStepRemoved,
    /// A step id is not one of this campaign's.
    UnknownStep,
    /// The campaign is trashed or gone.
    NotLive,
}

/// Outcome of replacing the sender rotation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendersOutcome {
    /// The rotation was replaced.
    Replaced,
    /// A mailbox is not the caller's, or is disconnected.
    NotOwned,
    /// The campaign is trashed or gone.
    NotLive,
}

/// Errors crossing the campaign boundary.
#[derive(Debug, thiserror::Error)]
pub enum CampaignError {
    /// Invalid user input.
    #[error("{0}")]
    Invalid(&'static str),
    /// A template names a field the recipient table lacks.
    #[error("Unknown merge field {{{{{0}}}}}; add a column with that name or a fallback")]
    UnknownField(String),
    /// Missing or inaccessible campaign.
    #[error("Campaign not found")]
    NotFound,
    /// The change conflicts with what has already been sent.
    #[error("{0}")]
    Conflict(&'static str),
    /// Access-layer refusal.
    #[error(transparent)]
    Access(#[from] entity_access::domain::models::AccessError),
    /// Database operation failure.
    #[error(transparent)]
    Database(#[from] databases::domain::models::DatabaseError),
    /// Persistence failure.
    #[error("Campaign storage failed: {0}")]
    Storage(rootcause::Report),
}
