//! Driven contracts: persistence and the CRM contact directory.

use super::models::{
    Campaign, CampaignBlueprint, CampaignSettings, CampaignSharing, CampaignStats,
    CampaignStatus, ContactAddress, Delivered, DeliveryError, DueRecipient, EncryptedSecret,
    Enrollment, IdentityCredentials, Mailbox, OutboundEmail, Recipient, RecipientUpdate,
    Reservation, Reserved, Secret, SendRecord, Sender, SenderUsage, SendersOutcome, Step,
    StepInput, StepsOutcome, StoredIdentity,
};
use chrono::{DateTime, Utc};
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

/// What the sender worker needs beyond editing: leasing due recipients and
/// recording each email around the provider call.
pub trait SenderRepo: CampaignRepo {
    /// Live, active campaigns.
    fn active_campaigns(&self) -> impl Future<Output = Result<Vec<Uuid>, Self::Error>> + Send;
    /// Lease up to `limit` recipients due by `now` until `lease_until`,
    /// skipping rows another worker holds.
    fn claim_due(
        &self,
        now: DateTime<Utc>,
        lease_until: DateTime<Utc>,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<DueRecipient>, Self::Error>> + Send;
    /// The rotation with each mailbox's owner and the emails this campaign
    /// reserved from it since `since`.
    fn sender_usage(
        &self,
        id: Uuid,
        since: DateTime<Utc>,
    ) -> impl Future<Output = Result<Vec<SenderUsage>, Self::Error>> + Send;
    /// Reserve the send before the provider call; an earlier reservation for
    /// the same step and address is returned instead.
    fn reserve(
        &self,
        reservation: &Reservation,
    ) -> impl Future<Output = Result<Reserved, Self::Error>> + Send;
    /// Record the send and move the recipient on in one transaction, if the
    /// recipient is still active at `claimed_position`.
    fn finalize(
        &self,
        send: Option<(Uuid, SendRecord)>,
        id: Uuid,
        row_id: RowId,
        claimed_position: u16,
        update: RecipientUpdate,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
    /// Complete an active campaign with no active recipients left.
    fn complete_if_done(&self, id: Uuid) -> impl Future<Output = Result<bool, Self::Error>> + Send;
    /// Mark sends since `since` answered by their recipient in any of the
    /// campaign owner's connected inboxes, and stop those recipients when
    /// the campaign stops on reply. Returns the sends marked.
    fn detect_replies(
        &self,
        since: DateTime<Utc>,
    ) -> impl Future<Output = Result<u64, Self::Error>> + Send;
    /// Mark sends since `since` that a mail server bounced, stop their
    /// recipients and suppress the address for the team. Returns the sends
    /// marked.
    fn detect_bounces(
        &self,
        since: DateTime<Utc>,
    ) -> impl Future<Output = Result<u64, Self::Error>> + Send;
    /// Stop mailing the send's recipient and suppress the address for the
    /// campaign's team; false when the send does not exist.
    fn unsubscribe(&self, send_id: Uuid) -> impl Future<Output = Result<bool, Self::Error>> + Send;
    /// Count an open of a sent email, when its campaign tracks opens.
    fn record_open(&self, send_id: Uuid) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

/// Storage of SMTP and SendGrid identities.
pub trait IdentityRepo: Send + Sync + 'static {
    /// Adapter error.
    type Error: std::error::Error + Send + Sync + 'static;
    /// The user's identities.
    fn list_identities(
        &self,
        user_id: &str,
    ) -> impl Future<Output = Result<Vec<StoredIdentity>, Self::Error>> + Send;
    /// One identity by id, whoever owns it.
    fn get_identity(
        &self,
        id: Uuid,
    ) -> impl Future<Output = Result<Option<StoredIdentity>, Self::Error>> + Send;
    /// Insert, or replace the user's identity with the same `From` address.
    fn upsert_identity(
        &self,
        identity: &StoredIdentity,
    ) -> impl Future<Output = Result<StoredIdentity, Self::Error>> + Send;
    /// Delete the user's identity; false when there was none.
    fn delete_identity(
        &self,
        user_id: &str,
        id: Uuid,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send;
}

/// Encrypts identity secrets, bound to their owner.
pub trait SecretCipher: Send + Sync + 'static {
    /// Adapter error; never carries plaintext.
    type Error: std::error::Error + Send + Sync + 'static;
    /// Encrypt for `owner`.
    fn encrypt(
        &self,
        owner: &str,
        secret: &Secret,
    ) -> impl Future<Output = Result<EncryptedSecret, Self::Error>> + Send;
    /// Decrypt what was encrypted for `owner`.
    fn decrypt(
        &self,
        owner: &str,
        secret: &EncryptedSecret,
    ) -> impl Future<Output = Result<Secret, Self::Error>> + Send;
}

/// Delivers rendered campaign email.
pub trait Outbox: Send + Sync + 'static {
    /// Send one email. Replaying the same `send_id` through a connected inbox
    /// returns the first outcome rather than sending again.
    fn deliver(
        &self,
        mailbox: &Mailbox,
        email: &OutboundEmail,
    ) -> impl Future<Output = Result<Delivered, DeliveryError>> + Send;
    /// Check an identity's credentials with its provider without sending.
    fn verify(
        &self,
        credentials: &IdentityCredentials,
    ) -> impl Future<Output = Result<(), DeliveryError>> + Send;
}

/// Sends from a connected inbox as its owner, through email's send
/// admission, so the email is an ordinary sent message. Implemented by
/// email.
pub trait InboxSend: Send + Sync + 'static {
    /// Admit one email from `link_id`. `email.send_id` is the attempt id:
    /// replaying it returns the first outcome instead of sending again.
    fn send(
        &self,
        link_id: Uuid,
        owner: &MacroUserIdStr<'static>,
        email: &OutboundEmail,
    ) -> impl Future<Output = Result<Delivered, DeliveryError>> + Send;
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
