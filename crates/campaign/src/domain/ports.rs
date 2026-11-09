//! Driven contracts: persistence and the CRM contact directory.

use super::models::{
    Campaign, CampaignBlueprint, CampaignSettings, CampaignSharing, CampaignStats,
    CampaignStatus, ContactAddress, Enrollment, Recipient, Sender, SendersOutcome, Step,
    StepInput, StepsOutcome,
};
use databases::domain::models::RowId;
use macro_user_id::user_id::MacroUserIdStr;
use models_permissions::share_permission::channel_share_permission::{
    ChannelSharePermission, UpdateChannelSharePermission,
};
use std::collections::HashMap;
use uuid::Uuid;

/// Persistence contract. Transactions and grant writes belong to the adapter.
pub trait CampaignRepo: Send + Sync + 'static {
    /// Adapter error.
    type Error: std::error::Error + Send + Sync + 'static;
    /// Holds a live campaign against concurrent trash/deletion.
    type Guard: Send;
    /// Acquire a lifecycle guard for reads.
    fn lock_live(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<Option<Self::Guard>, Self::Error>> + Send;
    /// Serialize policy changes and row writes for one live campaign.
    fn lock_write(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<Option<Self::Guard>, Self::Error>> + Send;
    /// Read metadata for a known set of accessible identities.
    fn get_many(
        &self,
        ids: &[Uuid],
    ) -> impl Future<Output = Result<Vec<Campaign>, Self::Error>> + Send;
    /// Insert metadata, backing database and grants atomically.
    fn create(
        &self,
        blueprint: &CampaignBlueprint,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// Rename a live campaign.
    fn rename(&self, id: Uuid, name: &str) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// Trash or restore.
    fn set_trashed(
        &self,
        id: Uuid,
        trashed: bool,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// Change the owning team's grant; ownership remains unchanged.
    fn share(
        &self,
        campaign: &Campaign,
        sharing: CampaignSharing,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// The channels, direct messages included, the campaign is shared with.
    fn channel_grants(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<Vec<ChannelSharePermission>, Self::Error>> + Send;
    /// Change channel grants while the campaign is live; false when it is not.
    fn update_channel_grants(
        &self,
        id: Uuid,
        grants: &[UpdateChannelSharePermission],
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;
    /// Replace window, days and tracking of a live campaign.
    fn update_settings(
        &self,
        id: Uuid,
        settings: &CampaignSettings,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// The sequence in order.
    fn steps(&self, id: Uuid) -> impl Future<Output = Result<Vec<Step>, Self::Error>> + Send;
    /// Replace the sequence in one transaction, keeping sent steps.
    fn replace_steps(
        &self,
        id: Uuid,
        steps: &[StepInput],
    ) -> impl Future<Output = Result<StepsOutcome, Self::Error>> + Send;
    /// The sender rotation in order.
    fn senders(&self, id: Uuid) -> impl Future<Output = Result<Vec<Sender>, Self::Error>> + Send;
    /// Replace the rotation with mailboxes `owner` holds.
    fn replace_senders(
        &self,
        id: Uuid,
        owner: &MacroUserIdStr<'static>,
        senders: &[Sender],
    ) -> impl Future<Output = Result<SendersOutcome, Self::Error>> + Send;
    /// Move a live campaign from one of `from` to `to`; false when it was in
    /// none of them. Activation records the first launch and the approval.
    fn transition(
        &self,
        id: Uuid,
        from: &[CampaignStatus],
        to: CampaignStatus,
        confirmation: Option<&str>,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;
    /// Insert recipients not yet enrolled whose address the team has not
    /// suppressed; returns how many were inserted.
    fn enroll(
        &self,
        id: Uuid,
        team_id: Uuid,
        recipients: &[Enrollment],
    ) -> impl Future<Output = Result<u64, Self::Error>> + Send;
    /// A page of recipients in row-id order.
    fn recipients(
        &self,
        id: Uuid,
        after: Option<RowId>,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<Recipient>, Self::Error>> + Send;
    /// Stop these recipients' sequences.
    fn remove_recipients(
        &self,
        id: Uuid,
        rows: &[RowId],
    ) -> impl Future<Output = Result<u64, Self::Error>> + Send;
    /// Recipient and send counts.
    fn stats(&self, id: Uuid) -> impl Future<Output = Result<CampaignStats, Self::Error>> + Send;
}

/// The team's CRM contacts, read for enrollment. Implemented by CRM.
pub trait ContactDirectory: Send + Sync + 'static {
    /// Adapter error.
    type Error: std::error::Error + Send + Sync + 'static;
    /// Address and name of those `contacts` of `team_id` that have an
    /// address and are not hidden.
    fn contact_addresses(
        &self,
        team_id: Uuid,
        contacts: &[Uuid],
    ) -> impl Future<Output = Result<HashMap<Uuid, ContactAddress>, Self::Error>> + Send;
}
