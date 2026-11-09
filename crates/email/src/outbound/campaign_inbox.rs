//! Campaign email from connected inboxes goes through the same send
//! admission as the composer, as the inbox's owner, so it is an ordinary
//! sent message: it lands in Sent, threads, syncs and shows in search like
//! one typed by hand.

use crate::domain::models::{ContactInfo, CreateDraftInput, EmailErr};
use crate::domain::send_attempt::{
    EmailSendService, SendAttemptId, SendAttemptStatus, SendSnapshot,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use campaign::domain::models::{Delivered, DeliveryError, OutboundEmail};
use campaign::domain::ports::InboxSend;
use macro_user_id::user_id::MacroUserIdStr;
use std::sync::Arc;
use uuid::Uuid;

/// Campaign sends over email's admission. The campaign's send id is the
/// attempt id, so replaying an interrupted send returns the first attempt.
pub struct CampaignInbox<Send> {
    service: Arc<Send>,
}

impl<Send> CampaignInbox<Send> {
    /// Wrap the send service.
    pub fn new(service: Arc<Send>) -> Self {
        Self { service }
    }
}

impl<Send: EmailSendService + 'static> InboxSend for CampaignInbox<Send> {
    async fn send(
        &self,
        link_id: Uuid,
        owner: &MacroUserIdStr<'static>,
        email: &OutboundEmail,
    ) -> Result<Delivered, DeliveryError> {
        let snapshot = SendSnapshot {
            message: draft(owner, email),
            attachment_ids: Vec::new(),
            forwarded_attachment_ids: Vec::new(),
            restore_body_html: None,
            restore_body_text: None,
            restore_body_macro: None,
        };
        let attempt = self
            .service
            .send_email(owner.clone(), link_id, SendAttemptId(email.send_id), snapshot)
            .await
            .map_err(|err| match err {
                // The attempt exists with other content: something already
                // went out under this id.
                EmailErr::SendAttemptConflict => DeliveryError::Uncertain(err.to_string()),
                EmailErr::InvalidSendSnapshot(_) | EmailErr::InvalidSender => {
                    DeliveryError::Rejected(err.to_string())
                }
                err => DeliveryError::Transient(err.to_string()),
            })?;
        match attempt.status {
            // Admitted: email's worker owns delivery from here.
            SendAttemptStatus::Accepted | SendAttemptStatus::Sending | SendAttemptStatus::Sent => {
                Ok(Delivered {
                    email_message_id: attempt.message_id,
                    rfc_message_id: None,
                })
            }
            SendAttemptStatus::Failed | SendAttemptStatus::Cancelled => Err(
                DeliveryError::Rejected(format!("send attempt {:?}", attempt.status)),
            ),
            SendAttemptStatus::DeliveryUnconfirmed => Err(DeliveryError::Uncertain(
                "provider acceptance unconfirmed".to_string(),
            )),
        }
    }
}

/// The message as the composer hands it to Send. `headers_json` is Macro
/// metadata, not MIME headers, so the unsubscribe link travels in the body.
fn draft(owner: &MacroUserIdStr<'static>, email: &OutboundEmail) -> CreateDraftInput {
    CreateDraftInput {
        frozen_signature_html: None,
        draft_generation: 0,
        sender_email: None,
        db_id: None,
        provider_id: None,
        replying_to_id: email.replying_to,
        provider_thread_id: None,
        thread_db_id: None,
        subject: email.subject.clone(),
        to: vec![ContactInfo {
            email: email.to_email.clone(),
            name: email.to_name.clone(),
            photo_url: None,
        }],
        cc: Vec::new(),
        bcc: Vec::new(),
        body_text: Some(email.body_text.clone()),
        body_html: Some(URL_SAFE_NO_PAD.encode(email.body_html.as_bytes())),
        body_macro: email.body_macro.clone(),
        headers_json: None,
        send_time: None,
        include_signature: None,
        actor: Some(owner.clone()),
        draft_client_binding: None,
        thread_client_binding: None,
    }
}
