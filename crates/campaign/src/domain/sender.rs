//! The sender: leases due recipients, picks a mailbox under its daily cap,
//! renders the step, reserves the send, delivers it and moves the recipient
//! on. The caller drives it on a timer; nothing here owns a runtime.

use super::identities::IdentityServiceImpl;
use super::links::{LinkAction, SignedLinks};
use super::models::{
    Campaign, CampaignError, CampaignStatus, DeliveryError, DueRecipient, FirstSend, Mailbox,
    MAX_SEND_ATTEMPTS, OutboundEmail, RecipientUpdate, Reservation, SendRecord, SendStatus,
    SenderMailbox, SenderUsage, Step,
};
use super::ports::{ContactDirectory, IdentityRepo, Outbox, SecretCipher, SenderRepo};
use super::schedule::{SendWindow, parse_zone};
use super::service::{CampaignServiceImpl, storage};
use super::template::{self, MergeFields};
use chrono::{DateTime, Duration, Utc};
use databases::domain::models::{ColumnDetail, ColumnId, RowId};
use databases::domain::storage::DatabaseStorageService;
use entity_access::domain::ports::{AccessibleCampaigns, EntityAccessService};
use macro_user_id::user_id::MacroUserIdStr;
use models_properties::service::property_option::PropertyOptionValue;
use models_properties::service::property_value::PropertyValue;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

/// How the sender paces itself.
#[derive(Debug, Clone, Copy)]
pub struct SenderLimits {
    /// Recipients leased per pass.
    pub batch: u32,
    /// How long a lease holds before another pass may take the recipient.
    pub lease: Duration,
    /// Wait before a capped or unconfigured rotation is tried again.
    pub capacity_wait: Duration,
}

impl Default for SenderLimits {
    fn default() -> Self {
        Self {
            batch: 100,
            lease: Duration::minutes(15),
            capacity_wait: Duration::hours(1),
        }
    }
}

/// Campaign sending, composed from the campaign and identity services.
pub struct CampaignSender<R, D, A, C, IR, Ci, O> {
    campaigns: Arc<CampaignServiceImpl<R, D, A, C>>,
    identities: Arc<IdentityServiceImpl<IR, Ci, O>>,
    links: Option<SignedLinks>,
    limits: SenderLimits,
}

/// Which mailbox a recipient's step goes out from.
enum Pick {
    /// The first email's mailbox, in its thread.
    Thread(usize),
    /// The least-used mailbox; a new thread.
    Fresh(usize),
    /// Every mailbox is at its cap or unusable.
    Full,
}

fn pick(usage: &[SenderUsage], first: Option<&FirstSend>) -> Pick {
    let usable = |usage: &SenderUsage| usage.owner.is_some() && usage.sent_today < usage.sender.daily_cap;
    if let Some(mailbox) = first.and_then(|first| first.mailbox)
        && let Some(index) = usage
            .iter()
            .position(|usage| usage.sender.mailbox == mailbox && usage.owner.is_some())
    {
        // Follow-ups wait for their thread's mailbox rather than switch.
        return if usable(&usage[index]) {
            Pick::Thread(index)
        } else {
            Pick::Full
        };
    }
    usage
        .iter()
        .enumerate()
        .filter(|(_, usage)| usable(usage))
        .min_by(|(_, a), (_, b)| {
            let load = |usage: &SenderUsage| f64::from(usage.sent_today) / f64::from(usage.sender.daily_cap);
            load(a).total_cmp(&load(b))
        })
        .map_or(Pick::Full, |(index, _)| Pick::Fresh(index))
}

/// A cell as merge-field text.
fn cell_text(value: &PropertyValue, column: &ColumnDetail) -> Option<String> {
    Some(match value {
        PropertyValue::Str(text) => text.clone(),
        PropertyValue::Num(number) => number.to_string(),
        PropertyValue::Bool(value) => if *value { "Yes" } else { "No" }.into(),
        PropertyValue::Date(date) => date.format("%B %-d, %Y").to_string(),
        PropertyValue::Link(links) => links.join(", "),
        PropertyValue::SelectOption(ids) => ids
            .iter()
            .filter_map(|id| {
                column
                    .definition
                    .property_options
                    .iter()
                    .find(|option| option.id == *id)
            })
            .map(|option| match &option.value {
                PropertyOptionValue::String(text) => text.clone(),
                PropertyOptionValue::Number(number) => number.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => return None,
    })
}

/// `Re: ` once.
fn reply_subject(subject: &str) -> String {
    let subject = subject.trim();
    if subject.get(..3).is_some_and(|prefix| prefix.eq_ignore_ascii_case("re:")) {
        subject.to_string()
    } else {
        format!("Re: {subject}")
    }
}

/// Wait before retrying a transient failure: 15 minutes, doubling, at most 6 hours.
fn backoff(attempts: u16) -> Duration {
    Duration::minutes((15_i64 << attempts.min(5)).min(6 * 60))
}

/// The domain of an address, for Message-IDs.
fn domain(address: &str) -> &str {
    address.rsplit_once('@').map_or("localhost", |(_, domain)| domain)
}

/// One campaign's working set for a pass.
struct Batch<'a> {
    campaign: &'a Campaign,
    steps: &'a [Step],
    window: SendWindow,
    columns: HashMap<ColumnId, &'a ColumnDetail>,
    cells: HashMap<RowId, HashMap<ColumnId, PropertyValue>>,
    usage: Vec<SenderUsage>,
    mailboxes: HashMap<SenderMailbox, Option<Mailbox>>,
}

impl<R, D, A, C, IR, Ci, O> CampaignSender<R, D, A, C, IR, Ci, O>
where
    R: SenderRepo,
    D: DatabaseStorageService,
    A: EntityAccessService + AccessibleCampaigns,
    C: ContactDirectory,
    IR: IdentityRepo,
    Ci: SecretCipher,
    O: Outbox,
{
    /// Compose at the application root. Without links, email carries no
    /// unsubscribe link or open pixel.
    pub fn new(
        campaigns: Arc<CampaignServiceImpl<R, D, A, C>>,
        identities: Arc<IdentityServiceImpl<IR, Ci, O>>,
        links: Option<SignedLinks>,
        limits: SenderLimits,
    ) -> Self {
        Self {
            campaigns,
            identities,
            links,
            limits,
        }
    }

    fn repo(&self) -> &R {
        &self.campaigns.repo
    }

    /// Record replies and bounces, enroll rows added to active campaigns and
    /// complete finished ones.
    #[tracing::instrument(skip(self), err)]
    pub async fn maintain(&self) -> Result<(), CampaignError> {
        // Replies and bounces arrive days after a send; follow-ups wait
        // longer still, so a month covers every sequence that is running.
        let since = Utc::now() - Duration::days(30);
        let replied = self.repo().detect_replies(since).await.map_err(storage)?;
        let bounced = self.repo().detect_bounces(since).await.map_err(storage)?;
        if replied + bounced > 0 {
            tracing::info!(replied, bounced, "campaign responses recorded");
        }
        let ids = self
            .repo()
            .active_campaigns()
            .await
            .map_err(storage)?;
        for campaign in self
            .repo()
            .get_many(&ids)
            .await
            .map_err(storage)?
        {
            let first_delay = self
                .repo()
                .steps(campaign.id)
                .await
                .map_err(storage)?
                .first()
                .map_or(0, |step| step.delay_minutes);
            if let Err(error) = self.campaigns.enroll_rows(&campaign, first_delay).await {
                tracing::warn!(campaign_id = %campaign.id, error = ?error, "campaign enrollment failed");
                continue;
            }
            self.repo()
                .complete_if_done(campaign.id)
                .await
                .map_err(storage)?;
        }
        Ok(())
    }

    /// Send what is due; returns how many recipients were leased, so the
    /// caller can run again at once when the batch was full.
    #[tracing::instrument(skip(self), err)]
    pub async fn send_due(&self, now: DateTime<Utc>) -> Result<usize, CampaignError> {
        let due = self
            .repo()
            .claim_due(now, now + self.limits.lease, self.limits.batch)
            .await
            .map_err(storage)?;
        let leased = due.len();
        let mut by_campaign: HashMap<Uuid, Vec<DueRecipient>> = HashMap::new();
        for recipient in due {
            by_campaign.entry(recipient.campaign_id).or_default().push(recipient);
        }
        for (id, recipients) in by_campaign {
            // A failed campaign leaves its leases to expire and come due again.
            if let Err(error) = self.send_campaign(id, recipients, now).await {
                tracing::error!(campaign_id = %id, error = ?error, "campaign send pass failed");
            }
        }
        Ok(leased)
    }

    async fn send_campaign(
        &self,
        id: Uuid,
        recipients: Vec<DueRecipient>,
        now: DateTime<Utc>,
    ) -> Result<(), CampaignError> {
        let Some(campaign) = self.repo().get_many(&[id]).await.map_err(storage)?.pop() else {
            return Ok(());
        };
        if campaign.status != CampaignStatus::Active || campaign.trashed_at.is_some() {
            return Ok(());
        }
        let steps = self.repo().steps(id).await.map_err(storage)?;
        let table = self.campaigns.recipient_table(&campaign).await?;
        let rows: Vec<RowId> = recipients.iter().map(|recipient| recipient.row_id).collect();
        let cells = self
            .campaigns
            .databases
            .storage_row_cells(campaign.database_id, campaign.table_id, &rows)
            .await?
            .into_iter()
            .map(|row| (row.row_id, row.cells))
            .collect();
        let mut batch = Batch {
            campaign: &campaign,
            steps: &steps,
            window: SendWindow::from_settings(&campaign.settings)?,
            columns: table
                .columns
                .iter()
                .map(|column| (column.column.id, column))
                .collect(),
            cells,
            usage: self
                .repo()
                .sender_usage(id, now - Duration::days(1))
                .await
                .map_err(storage)?,
            mailboxes: HashMap::new(),
        };
        for recipient in recipients {
            if let Err(error) = self.send_one(&mut batch, &recipient, now).await {
                tracing::error!(campaign_id = %id, row_id = ?recipient.row_id, error = ?error, "campaign send failed");
            }
        }
        Ok(())
    }

    /// The delivery mailbox of a rotation slot, resolved once per pass.
    async fn mailbox(&self, batch: &mut Batch<'_>, index: usize) -> Result<Option<Mailbox>, CampaignError> {
        let usage = &batch.usage[index];
        let key = usage.sender.mailbox;
        if let Some(mailbox) = batch.mailboxes.get(&key) {
            return Ok(mailbox.clone());
        }
        let Some(owner) = usage.owner.clone() else {
            return Ok(None);
        };
        let mailbox = match key {
            SenderMailbox::Link { link_id } => MacroUserIdStr::try_from(owner)
                .ok()
                .map(|owner| Mailbox::Inbox { link_id, owner }),
            SenderMailbox::Identity { identity_id } => self
                .identities
                .credentials(&owner, identity_id)
                .await?
                .map(Mailbox::Identity),
        };
        if mailbox.is_none() {
            // Unusable for the rest of the pass.
            batch.usage[index].owner = None;
        }
        batch.mailboxes.insert(key, mailbox.clone());
        Ok(mailbox)
    }

    /// The recipient's next state after `step` went out at `now`.
    fn advance(&self, batch: &Batch<'_>, recipient: &DueRecipient, step: &Step, now: DateTime<Utc>) -> RecipientUpdate {
        match batch.steps.iter().find(|next| next.position > step.position) {
            Some(next) => {
                let window = match recipient.time_zone.as_deref().and_then(parse_zone) {
                    Some(zone) => batch.window.in_zone(zone),
                    None => batch.window,
                };
                RecipientUpdate::Advance {
                    position: next.position,
                    at: Some(window.next_open(now + Duration::minutes(next.delay_minutes.into()))),
                }
            }
            None => RecipientUpdate::Advance {
                position: step.position + 1,
                at: None,
            },
        }
    }

    async fn finalize(
        &self,
        recipient: &DueRecipient,
        send: Option<(Uuid, SendRecord)>,
        update: RecipientUpdate,
    ) -> Result<(), CampaignError> {
        self.repo()
            .finalize(send, recipient.campaign_id, recipient.row_id, recipient.position, update)
            .await
            .map_err(storage)
    }

    fn render(
        &self,
        batch: &Batch<'_>,
        recipient: &DueRecipient,
        step: &Step,
        send_id: Uuid,
    ) -> Result<(String, String, String, Option<String>), CampaignError> {
        let mut fields = MergeFields::default();
        if let Some(cells) = batch.cells.get(&recipient.row_id) {
            for (column_id, value) in cells {
                if let Some(column) = batch.columns.get(column_id)
                    && let Some(text) = cell_text(value, column)
                {
                    fields.insert(column.name(), text);
                }
            }
        }
        // Built-ins win over columns of the same name.
        fields.merge(MergeFields::for_recipient(&recipient.email, recipient.name.as_deref()));
        let unsubscribe = self
            .links
            .as_ref()
            .map(|links| links.url(LinkAction::Unsubscribe, send_id));
        fields.insert("unsubscribe link", unsubscribe.clone().unwrap_or_default());
        let first_subject = recipient.first.as_ref().and_then(|first| first.subject.clone());
        let subject = if step.subject.trim().is_empty() {
            match first_subject {
                Some(subject) => reply_subject(&subject),
                None => {
                    let opening = batch.steps.first().map_or("", |step| step.subject.as_str());
                    template::render(opening, &fields, false)?
                }
            }
        } else {
            template::render(&step.subject, &fields, false)?
        };
        let mut html = template::render(&step.body_html, &fields, true)?;
        let text = match &step.body_text {
            Some(text) if !text.trim().is_empty() => template::render(text, &fields, false)?,
            _ => email_utils::body_parsed::html_to_plaintext(&html).unwrap_or_default(),
        };
        if batch.campaign.settings.track_opens
            && let Some(links) = &self.links
        {
            html.push_str(&format!(
                r#"<img src="{}" width="1" height="1" alt="" style="display:none">"#,
                links.url(LinkAction::Open, send_id)
            ));
        }
        Ok((subject, html, text, unsubscribe))
    }

    #[tracing::instrument(skip_all, fields(campaign_id = %recipient.campaign_id, position = recipient.position), err)]
    async fn send_one(
        &self,
        batch: &mut Batch<'_>,
        recipient: &DueRecipient,
        now: DateTime<Utc>,
    ) -> Result<(), CampaignError> {
        let Some(step) = batch
            .steps
            .iter()
            .find(|step| step.position == recipient.position)
            .cloned()
        else {
            // The sequence was shortened past this recipient.
            return self
                .finalize(
                    recipient,
                    None,
                    RecipientUpdate::Advance {
                        position: recipient.position,
                        at: None,
                    },
                )
                .await;
        };
        let window = match recipient.time_zone.as_deref().and_then(parse_zone) {
            Some(zone) => batch.window.in_zone(zone),
            None => batch.window,
        };
        let open = window.next_open(now);
        if open > now + Duration::minutes(1) {
            return self
                .finalize(recipient, None, RecipientUpdate::Defer { at: open })
                .await;
        }
        let (index, thread) = match pick(&batch.usage, recipient.first.as_ref()) {
            Pick::Thread(index) => (index, true),
            Pick::Fresh(index) => (index, false),
            Pick::Full => {
                return self
                    .finalize(
                        recipient,
                        None,
                        RecipientUpdate::Defer {
                            at: window.next_open(now + self.limits.capacity_wait),
                        },
                    )
                    .await;
            }
        };
        let Some(mailbox) = self.mailbox(batch, index).await? else {
            // Lost this pass; the next one picks another mailbox.
            return Ok(());
        };
        let slot = batch.usage[index].sender.mailbox;
        let send_id = macro_uuid::generate_uuid_v7();
        let rfc_message_id = match &mailbox {
            Mailbox::Identity(credentials) => Some(format!(
                "<{send_id}@{}>",
                domain(&credentials.identity.from_email)
            )),
            Mailbox::Inbox { .. } => None,
        };
        let (subject, body_html, body_text, unsubscribe_url) = self.render(batch, recipient, &step, send_id)?;
        let reserved = self
            .repo()
            .reserve(&Reservation {
                id: send_id,
                campaign_id: recipient.campaign_id,
                step_id: step.id,
                row_id: recipient.row_id,
                recipient_email: recipient.email.clone(),
                mailbox: slot,
                rfc_message_id: rfc_message_id.clone(),
                subject: subject.clone(),
            })
            .await
            .map_err(storage)?;
        let advance = self.advance(batch, recipient, &step, now);
        let (send_id, mailbox, rfc_message_id) = if reserved.inserted {
            (send_id, mailbox, rfc_message_id)
        } else {
            match reserved.status {
                SendStatus::Sent | SendStatus::Uncertain => {
                    return self
                        .finalize(recipient, Some((reserved.id, SendRecord::Unchanged)), advance)
                        .await;
                }
                SendStatus::Failed => {
                    return self
                        .finalize(recipient, Some((reserved.id, SendRecord::Unchanged)), RecipientUpdate::Fail)
                        .await;
                }
                SendStatus::Reserved => {
                    // Email's admission is keyed by the attempt id, so the
                    // same inbox replays the first outcome.
                    let replay = matches!(
                        (reserved.mailbox, &mailbox),
                        (Some(SenderMailbox::Link { link_id }), Mailbox::Inbox { link_id: picked, .. })
                            if link_id == *picked
                    );
                    if !replay {
                        let record = SendRecord::Uncertain("Interrupted before the provider answered".into());
                        return self.finalize(recipient, Some((reserved.id, record)), advance).await;
                    }
                    (reserved.id, mailbox, reserved.rfc_message_id)
                }
            }
        };
        let (replying_to, in_reply_to) = match (&mailbox, thread, recipient.first.as_ref()) {
            (Mailbox::Inbox { .. }, true, Some(first)) => (first.email_message_id, None),
            (Mailbox::Identity(_), true, Some(first)) => (None, first.rfc_message_id.clone()),
            _ => (None, None),
        };
        let email = OutboundEmail {
            send_id,
            to_email: recipient.email.clone(),
            to_name: recipient.name.clone(),
            subject,
            body_html,
            body_text,
            body_macro: None,
            rfc_message_id: rfc_message_id.clone(),
            replying_to,
            in_reply_to,
            unsubscribe_url,
        };
        let outcome = self.identities.outbox.deliver(&mailbox, &email).await;
        let (record, update) = match outcome {
            Ok(delivered) => {
                batch.usage[index].sent_today += 1;
                (
                    SendRecord::Sent {
                        email_message_id: delivered.email_message_id,
                        rfc_message_id: delivered.rfc_message_id.or(rfc_message_id),
                    },
                    advance,
                )
            }
            Err(DeliveryError::Rejected(error)) => (SendRecord::Failed(error), RecipientUpdate::Fail),
            Err(DeliveryError::Uncertain(error)) => {
                batch.usage[index].sent_today += 1;
                (SendRecord::Uncertain(error), advance)
            }
            Err(DeliveryError::Transient(error)) if recipient.send_attempts + 1 >= MAX_SEND_ATTEMPTS => {
                (SendRecord::Failed(error), RecipientUpdate::Fail)
            }
            Err(DeliveryError::Transient(error)) => {
                tracing::warn!(error = %error, "campaign send will be retried");
                // An inbox keeps its reservation so the retry replays the
                // same attempt; SMTP and SendGrid sent nothing.
                let record = match mailbox {
                    Mailbox::Inbox { .. } => SendRecord::Unchanged,
                    Mailbox::Identity(_) => SendRecord::Withdrawn,
                };
                (
                    record,
                    RecipientUpdate::Retry {
                        at: now + backoff(recipient.send_attempts),
                    },
                )
            }
        };
        self.finalize(recipient, Some((send_id, record)), update).await
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::domain::models::Sender;

    fn slot(cap: u32, sent: u32, owned: bool) -> SenderUsage {
        SenderUsage {
            sender: Sender {
                mailbox: SenderMailbox::Link {
                    link_id: Uuid::new_v4(),
                },
                daily_cap: cap,
            },
            owner: owned.then(|| "macro|a@b.c".to_string()),
            sent_today: sent,
        }
    }

    #[test]
    fn fresh_sends_go_to_the_least_loaded_usable_mailbox() {
        let usage = [slot(10, 9, true), slot(100, 20, true), slot(100, 0, false), slot(5, 5, true)];
        assert!(matches!(pick(&usage, None), Pick::Fresh(1)));
    }

    #[test]
    fn follow_ups_wait_for_their_threads_mailbox() {
        let usage = [slot(10, 10, true), slot(100, 0, true)];
        let first = FirstSend {
            mailbox: Some(usage[0].sender.mailbox),
            email_message_id: None,
            rfc_message_id: None,
            subject: Some("Hi".into()),
        };
        assert!(matches!(pick(&usage, Some(&first)), Pick::Full));
        let gone = FirstSend {
            mailbox: None,
            ..first
        };
        assert!(matches!(pick(&usage, Some(&gone)), Pick::Fresh(1)));
    }

    #[test]
    fn reply_subjects_and_backoff() {
        assert_eq!(reply_subject("Hello"), "Re: Hello");
        assert_eq!(reply_subject("RE: Hello"), "RE: Hello");
        assert_eq!(backoff(0), Duration::minutes(15));
        assert_eq!(backoff(9), Duration::hours(6));
    }
}
