//! Driven adapters.

/// Identity secrets under AWS KMS.
#[cfg(feature = "kms")]
pub mod kms;
/// The outbox: connected inboxes, SMTP and SendGrid.
#[cfg(feature = "delivery")]
pub mod mail_outbox;
/// Postgres campaign storage over the databases domain writer.
#[cfg(feature = "postgres")]
pub mod pg_campaign_repo;
/// Postgres storage of SMTP and SendGrid identities.
#[cfg(feature = "postgres")]
pub mod pg_identity_repo;
/// SendGrid v3 Mail Send.
#[cfg(feature = "delivery")]
pub mod sendgrid;
/// SMTP submission over TLS.
#[cfg(feature = "delivery")]
pub mod smtp;
