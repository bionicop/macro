//! The outbox: each mailbox to its transport.

use super::sendgrid::SendGridSender;
use super::smtp::SmtpSender;
use crate::domain::models::{
    Delivered, DeliveryError, IdentityCredentials, IdentityTransport, Mailbox, OutboundEmail,
};
use crate::domain::ports::{InboxSend, Outbox};

/// Connected inboxes through email's send admission; identities over SMTP
/// or SendGrid.
pub struct MailOutbox<Inbox> {
    inbox: Inbox,
    smtp: SmtpSender,
    sendgrid: SendGridSender,
}

impl<Inbox: InboxSend> MailOutbox<Inbox> {
    /// Compose at the application root over email's inbox sender.
    pub fn new(inbox: Inbox) -> Self {
        Self {
            inbox,
            smtp: SmtpSender::new(),
            sendgrid: SendGridSender::new(),
        }
    }
}

impl<Inbox: InboxSend> Outbox for MailOutbox<Inbox> {
    #[tracing::instrument(skip_all, fields(send_id = %email.send_id), err)]
    async fn deliver(&self, mailbox: &Mailbox, email: &OutboundEmail) -> Result<Delivered, DeliveryError> {
        match mailbox {
            Mailbox::Inbox { link_id, owner } => self.inbox.send(*link_id, owner, email).await,
            Mailbox::Identity(credentials) => match credentials.identity.transport {
                IdentityTransport::Smtp => self.smtp.deliver(credentials, email).await,
                IdentityTransport::Sendgrid => self.sendgrid.deliver(credentials, email).await,
            },
        }
    }

    async fn verify(&self, credentials: &IdentityCredentials) -> Result<(), DeliveryError> {
        match credentials.identity.transport {
            IdentityTransport::Smtp => self.smtp.verify(credentials).await,
            IdentityTransport::Sendgrid => self.sendgrid.verify(credentials).await,
        }
    }
}
