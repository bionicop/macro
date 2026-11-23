//! Campaign values crossing the service boundary.

use chrono::{DateTime, NaiveDate, Utc};
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
    /// Queue a draft reply, for the owner to review, when a recipient replies.
    /// Drafts are never sent automatically.
    #[serde(default)]
    pub auto_draft_replies: bool,
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
            auto_draft_replies: false,
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

/// Whether a step is sent to a recipient, judged when the step comes due by
/// whether they opened any earlier email of the sequence. A step that is not
/// sent is skipped: the recipient moves on to the next step, which waits its
/// own delay from the moment of the skip.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepCondition {
    /// Send to everyone still in the sequence.
    #[default]
    Always,
    /// Send only if no earlier email was opened (the first step has none, so
    /// it is always sent).
    NotOpened,
    /// Send only if an earlier email was opened (never true for the first step).
    Opened,
}

impl StepCondition {
    /// Whether the step goes out to a recipient who has (not) opened an
    /// earlier email.
    pub fn is_met(self, opened_earlier: bool) -> bool {
        match self {
            Self::Always => true,
            Self::NotOpened => !opened_earlier,
            Self::Opened => opened_earlier,
        }
    }
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
    /// When to send: always, only if no earlier email was opened, or only if
    /// one was.
    pub condition: StepCondition,
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
    /// When to send; always when absent.
    #[serde(default)]
    pub condition: StepCondition,
}

/// Where a reply draft stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReplyDraftStatus {
    /// Queued; no text yet.
    Pending,
    /// Has text, waiting for review.
    Ready,
    /// Set aside; it is not sent.
    Dismissed,
    /// The reply went out.
    Sent,
}

impl ReplyDraftStatus {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Dismissed => "dismissed",
            Self::Sent => "sent",
        }
    }

    /// Parse the stored text.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "pending" => Self::Pending,
            "ready" => Self::Ready,
            "dismissed" => Self::Dismissed,
            "sent" => Self::Sent,
            _ => return None,
        })
    }
}

/// A draft reply to a recipient's reply, written for the owner to review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplyDraft {
    /// Stable identity.
    pub id: Uuid,
    /// The campaign.
    pub campaign_id: Uuid,
    /// The recipient's row; absent once the row is deleted.
    #[schema(required = true)]
    pub row_id: Option<Uuid>,
    /// The recipient's address.
    pub recipient_email: String,
    /// The campaign email they replied to.
    #[schema(required = true)]
    pub send_id: Option<Uuid>,
    /// Their reply in email.
    pub inbound_message_id: Uuid,
    /// The thread the reply belongs to.
    #[schema(required = true)]
    pub thread_id: Option<Uuid>,
    /// Their reply's subject.
    #[schema(required = true)]
    pub inbound_subject: Option<String>,
    /// The start of their reply's text.
    #[schema(required = true)]
    pub inbound_text: Option<String>,
    /// Where the draft stands.
    pub status: ReplyDraftStatus,
    /// The drafted subject; empty until written.
    pub draft_subject: String,
    /// The drafted body; empty until written.
    pub draft_body: String,
    /// When the reply was queued.
    pub created_at: DateTime<Utc>,
    /// When it last changed.
    pub updated_at: DateTime<Utc>,
}

/// What a person or agent can do to a draft besides write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReplyDraftAction {
    /// Set the draft aside.
    Dismissed,
}

/// An edit to a draft. Writing text makes a pending draft ready; clearing the
/// body makes it pending again. A sent or dismissed draft cannot be changed.
#[derive(Debug, Clone, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyDraftUpdate {
    /// New subject.
    #[serde(default)]
    pub subject: Option<String>,
    /// New body.
    #[serde(default)]
    pub body: Option<String>,
    /// `dismissed` to set the draft aside.
    #[serde(default)]
    pub status: Option<ReplyDraftAction>,
}

/// How an edit to a draft ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyDraftOutcome {
    /// Saved.
    Updated(ReplyDraft),
    /// No such draft in this campaign.
    NotFound,
    /// Already sent or dismissed.
    Closed(ReplyDraftStatus),
}

/// A queued reply, with what the writer needs to answer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyDraftRequest {
    /// The draft to fill.
    pub id: Uuid,
    /// The campaign.
    pub campaign_id: Uuid,
    /// Who replied.
    pub recipient_email: String,
    /// Subject of the campaign email they answered.
    pub sent_subject: Option<String>,
    /// Their reply's subject.
    pub inbound_subject: Option<String>,
    /// The start of their reply.
    pub inbound_text: Option<String>,
}

/// Text written for a draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyDraftText {
    /// Subject; empty keeps the thread's.
    pub subject: String,
    /// Body.
    pub body: String,
}

/// The mailbox a sender slot sends from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
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

/// Longest range a daily series may cover.
pub const MAX_DAILY_DAYS: i64 = 366;

/// Counts for one calendar day, bucketed in the requested time zone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DailyCounts {
    /// Emails sent that day.
    pub sent: u64,
    /// Sent emails first opened that day.
    pub opened: u64,
    /// Replies received that day.
    pub replied: u64,
    /// Bounces recorded that day.
    pub bounced: u64,
}

/// One day of a daily series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DailyStatsDay {
    /// Calendar date in the requested time zone, YYYY-MM-DD.
    #[schema(value_type = String, format = Date)]
    pub date: NaiveDate,
    /// Emails sent.
    pub sent: u64,
    /// Sent emails first opened.
    pub opened: u64,
    /// Replies received.
    pub replied: u64,
    /// Bounces recorded.
    pub bounced: u64,
}

/// Activity per day over a range, one entry per date including zero days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    /// Days in ascending order.
    pub days: Vec<DailyStatsDay>,
}

/// A validated inclusive date range and the zone its days are cut in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DailyRange {
    /// First day, inclusive.
    pub from: NaiveDate,
    /// Last day, inclusive.
    pub to: NaiveDate,
    /// Zone whose midnights bound each day.
    pub tz: chrono_tz::Tz,
}

impl DailyRange {
    /// From on or before to, at most 366 days, and a real IANA zone
    /// (UTC when none is given).
    pub fn new(from: NaiveDate, to: NaiveDate, tz: Option<&str>) -> Result<Self, CampaignError> {
        if from > to {
            return Err(CampaignError::Invalid("Start the range on or before its end"));
        }
        if (to - from).num_days() + 1 > MAX_DAILY_DAYS {
            return Err(CampaignError::Invalid("Ask for at most 366 days at a time"));
        }
        let tz = match tz.map(str::trim).filter(|name| !name.is_empty()) {
            None => chrono_tz::Tz::UTC,
            Some(name) => name.parse().map_err(|_| {
                CampaignError::Invalid("Use an IANA time zone such as America/New_York")
            })?,
        };
        Ok(Self { from, to, tz })
    }

    /// Fill every date in the range, in order, with the counts found for it
    /// (zero where there are none). Counts outside the range are ignored.
    pub fn fill(&self, found: impl IntoIterator<Item = (NaiveDate, DailyCounts)>) -> DailyStats {
        let mut totals = std::collections::BTreeMap::<NaiveDate, DailyCounts>::new();
        for (date, counts) in found {
            let total = totals.entry(date).or_default();
            total.sent += counts.sent;
            total.opened += counts.opened;
            total.replied += counts.replied;
            total.bounced += counts.bounced;
        }
        let days = self
            .from
            .iter_days()
            .take_while(|date| *date <= self.to)
            .map(|date| {
                let counts = totals.get(&date).copied().unwrap_or_default();
                DailyStatsDay {
                    date,
                    sent: counts.sent,
                    opened: counts.opened,
                    replied: counts.replied,
                    bounced: counts.bounced,
                }
            })
            .collect();
        DailyStats { days }
    }
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

/// How a sending identity delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum IdentityTransport {
    /// SMTP submission; replies are read by IMAP.
    Smtp,
    /// The SendGrid v3 mail API.
    Sendgrid,
}

impl IdentityTransport {
    /// Database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Smtp => "smtp",
            Self::Sendgrid => "sendgrid",
        }
    }
    /// Parse the database representation.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "smtp" => Self::Smtp,
            "sendgrid" => Self::Sendgrid,
            _ => return None,
        })
    }
}

/// An SMTP or SendGrid mailbox a user may add to campaigns. The secret is
/// never returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendingIdentity {
    /// Identity, used as a sender's `identityId`.
    pub id: Uuid,
    /// Delivery.
    pub transport: IdentityTransport,
    /// The `From` address.
    pub from_email: String,
    /// The `From` display name.
    #[schema(required = true)]
    pub from_name: Option<String>,
    /// SMTP submission host.
    #[schema(required = true)]
    pub smtp_host: Option<String>,
    /// SMTP submission port: 465 for implicit TLS, otherwise STARTTLS.
    #[schema(required = true)]
    pub smtp_port: Option<u16>,
    /// IMAP host polled for replies and bounces.
    #[schema(required = true)]
    pub imap_host: Option<String>,
    /// IMAP port, implicit TLS.
    #[schema(required = true)]
    pub imap_port: Option<u16>,
    /// SMTP and IMAP login.
    #[schema(required = true)]
    pub username: Option<String>,
    /// When the provider last accepted the credentials.
    #[schema(required = true)]
    pub verified_at: Option<DateTime<Utc>>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
}

/// A password or API key as typed. Redacts its `Debug` and zeroizes on drop.
#[derive(Clone)]
pub struct Secret(zeroize::Zeroizing<String>);

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

impl Secret {
    /// Wrap plaintext.
    pub fn new(value: String) -> Self {
        Self(zeroize::Zeroizing::new(value))
    }
    /// The plaintext, only for the transport that authenticates with it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(redacted)")
    }
}

/// Add an SMTP or SendGrid identity. The credentials are checked with the
/// provider before anything is stored, and stored encrypted.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSendingIdentity {
    /// Delivery.
    pub transport: IdentityTransport,
    /// The `From` address; a SendGrid sender must be verified there.
    pub from_email: String,
    /// The `From` display name.
    #[serde(default)]
    pub from_name: Option<String>,
    /// SMTP submission host; required for SMTP.
    #[serde(default)]
    pub smtp_host: Option<String>,
    /// SMTP port; required for SMTP.
    #[serde(default)]
    pub smtp_port: Option<u16>,
    /// IMAP host for replies; optional.
    #[serde(default)]
    pub imap_host: Option<String>,
    /// IMAP port; defaults to 993 with a host.
    #[serde(default)]
    pub imap_port: Option<u16>,
    /// Login; required for SMTP.
    #[serde(default)]
    pub username: Option<String>,
    /// SMTP password (an app password for Gmail) or SendGrid API key.
    #[schema(value_type = String)]
    pub secret: Secret,
}

/// KMS ciphertext of a secret, bound to its owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedSecret {
    /// Ciphertext blob.
    pub ciphertext: Vec<u8>,
    /// Scheme that produced it.
    pub encryption_version: i16,
    /// Key that encrypted it.
    pub kms_key_id: String,
}

/// An identity as stored.
#[derive(Debug, Clone)]
pub struct StoredIdentity {
    /// Public fields.
    pub identity: SendingIdentity,
    /// Owner the secret is bound to.
    pub user_id: String,
    /// The encrypted secret.
    pub secret: EncryptedSecret,
}

/// Credentials ready for one delivery; never logged.
#[derive(Debug, Clone)]
pub struct IdentityCredentials {
    /// Public fields.
    pub identity: SendingIdentity,
    /// Decrypted password or API key.
    pub secret: Secret,
}

/// A sending slot with the owner of its mailbox and today's use.
#[derive(Debug, Clone)]
pub struct SenderUsage {
    /// The slot.
    pub sender: Sender,
    /// Mailbox owner; `None` once the inbox is disconnected.
    pub owner: Option<String>,
    /// Emails this campaign reserved from the mailbox in the last day.
    pub sent_today: u32,
}

/// The mailbox and thread of a recipient's first email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstSend {
    /// Mailbox it went out from; `None` if that mailbox was deleted.
    pub mailbox: Option<SenderMailbox>,
    /// Email's message row, for connected inboxes.
    pub email_message_id: Option<Uuid>,
    /// RFC 5322 Message-ID, for SMTP and SendGrid.
    pub rfc_message_id: Option<String>,
    /// Subject as sent.
    pub subject: Option<String>,
}

/// A recipient whose next step is due, leased to one sender until its
/// lease ends.
#[derive(Debug, Clone)]
pub struct DueRecipient {
    /// Campaign.
    pub campaign_id: Uuid,
    /// Recipient row.
    pub row_id: RowId,
    /// Address.
    pub email: String,
    /// Name.
    pub name: Option<String>,
    /// Zone.
    pub time_zone: Option<String>,
    /// Step to send.
    pub position: u16,
    /// Consecutive transient failures.
    pub send_attempts: u16,
    /// The first email, for follow-ups.
    pub first: Option<FirstSend>,
    /// Whether any email sent to them at an earlier step has been opened.
    pub opened_earlier: bool,
}

/// Transient failures of one step before the recipient's sequence fails.
pub const MAX_SEND_ATTEMPTS: u16 = 5;

/// Status of one reserved email.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SendStatus {
    /// Reserved; the provider call may or may not have happened.
    Reserved,
    /// Accepted by the provider or by email's send admission.
    Sent,
    /// Refused for good.
    Failed,
    /// Possibly delivered; never retried.
    Uncertain,
}

impl SendStatus {
    /// Database representation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Sent => "sent",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
        }
    }
    /// Parse the database representation.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "reserved" => Self::Reserved,
            "sent" => Self::Sent,
            "failed" => Self::Failed,
            "uncertain" => Self::Uncertain,
            _ => return None,
        })
    }
}

/// A send row to reserve before the provider call.
#[derive(Debug, Clone)]
pub struct Reservation {
    /// New send id; also email's send attempt id.
    pub id: Uuid,
    /// Campaign.
    pub campaign_id: Uuid,
    /// Step.
    pub step_id: Uuid,
    /// Recipient row.
    pub row_id: RowId,
    /// Address.
    pub recipient_email: String,
    /// Mailbox.
    pub mailbox: SenderMailbox,
    /// Message-ID this email will carry, when the sender chooses it.
    pub rfc_message_id: Option<String>,
    /// Rendered subject.
    pub subject: String,
}

/// The reserved row: this reservation, or an earlier one for the same step
/// and address.
#[derive(Debug, Clone)]
pub struct Reserved {
    /// Send id.
    pub id: Uuid,
    /// Whether this call inserted it.
    pub inserted: bool,
    /// Current status.
    pub status: SendStatus,
    /// Mailbox it was reserved on.
    pub mailbox: Option<SenderMailbox>,
    /// Message-ID it was reserved with.
    pub rfc_message_id: Option<String>,
}

/// What became of a reserved send.
#[derive(Debug, Clone)]
pub enum SendRecord {
    /// Accepted.
    Sent {
        /// Email's message row.
        email_message_id: Option<Uuid>,
        /// RFC Message-ID, when known.
        rfc_message_id: Option<String>,
    },
    /// Refused for good.
    Failed(String),
    /// Possibly delivered.
    Uncertain(String),
    /// Nothing was sent; the reservation is withdrawn so a retry can make it.
    Withdrawn,
    /// Settled earlier; the row stays as it is.
    Unchanged,
}

/// How a recipient moves on after a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientUpdate {
    /// Due for `position` at `at`, or finished when `at` is `None`.
    Advance {
        /// Next step.
        position: u16,
        /// When it is due.
        at: Option<DateTime<Utc>>,
    },
    /// A permanent failure ends the sequence.
    Fail,
    /// Try the same step again at `at`, counting the attempt.
    Retry {
        /// When.
        at: DateTime<Utc>,
    },
    /// Wait for capacity without counting an attempt.
    Defer {
        /// When.
        at: DateTime<Utc>,
    },
}

/// One rendered email, ready for a transport.
#[derive(Debug, Clone)]
pub struct OutboundEmail {
    /// Send id: email's attempt id, and the local part of the Message-ID.
    pub send_id: Uuid,
    /// Recipient.
    pub to_email: String,
    /// Recipient name.
    pub to_name: Option<String>,
    /// Subject.
    pub subject: String,
    /// HTML body.
    pub body_html: String,
    /// Plain-text body.
    pub body_text: String,
    /// The composer's document, for connected inboxes.
    pub body_macro: Option<String>,
    /// Message-ID to set, for SMTP and SendGrid.
    pub rfc_message_id: Option<String>,
    /// The thread's first email in a connected inbox.
    pub replying_to: Option<Uuid>,
    /// The thread's first Message-ID, for SMTP and SendGrid threading.
    pub in_reply_to: Option<String>,
    /// One-click unsubscribe URL (RFC 8058).
    pub unsubscribe_url: Option<String>,
}

/// The mailbox an email goes out from, resolved for delivery.
#[derive(Debug, Clone)]
pub enum Mailbox {
    /// A connected inbox, sent as its owner through email's send admission.
    Inbox {
        /// `email_links` row.
        link_id: Uuid,
        /// Its owner.
        owner: MacroUserIdStr<'static>,
    },
    /// An SMTP or SendGrid identity.
    Identity(IdentityCredentials),
}

/// What a transport did.
#[derive(Debug, Clone, Default)]
pub struct Delivered {
    /// Email's message row, for connected inboxes.
    pub email_message_id: Option<Uuid>,
    /// RFC Message-ID, when known.
    pub rfc_message_id: Option<String>,
}

/// Why a transport did not deliver.
#[derive(Debug, Clone, thiserror::Error)]
pub enum DeliveryError {
    /// Nothing was sent and a later attempt may succeed.
    #[error("Temporary delivery failure: {0}")]
    Transient(String),
    /// The provider refused this email for good.
    #[error("Delivery refused: {0}")]
    Rejected(String),
    /// The provider may have accepted it; it must not be sent again.
    #[error("Delivery outcome unknown: {0}")]
    Uncertain(String),
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
    /// A mail provider refused or failed a check.
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
    /// A capability this deployment has not configured.
    #[error("{0}")]
    Unavailable(&'static str),
    /// Persistence failure.
    #[error("Campaign storage failed: {0}")]
    Storage(rootcause::Report),
}
