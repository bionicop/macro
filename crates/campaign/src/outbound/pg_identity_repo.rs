//! SMTP and SendGrid identities. Secrets arrive and leave encrypted; this
//! adapter never sees plaintext.

use super::pg_campaign_repo::PgCampaignRepo;
use crate::domain::models::{EncryptedSecret, IdentityTransport, SendingIdentity, StoredIdentity};
use crate::domain::ports::IdentityRepo;
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// One `campaign_sending_identities` row.
struct IdentityRow {
    id: Uuid,
    user_id: String,
    transport: String,
    from_email: String,
    from_name: Option<String>,
    smtp_host: Option<String>,
    smtp_port: Option<i32>,
    imap_host: Option<String>,
    imap_port: Option<i32>,
    username: Option<String>,
    secret_ciphertext: Vec<u8>,
    encryption_version: i16,
    kms_key_id: String,
    verified_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

fn port(value: Option<i32>) -> Option<u16> {
    value.and_then(|port| u16::try_from(port).ok())
}

impl TryFrom<IdentityRow> for StoredIdentity {
    type Error = sqlx::Error;

    fn try_from(row: IdentityRow) -> Result<Self, Self::Error> {
        Ok(StoredIdentity {
            identity: SendingIdentity {
                id: row.id,
                transport: IdentityTransport::parse(&row.transport)
                    .ok_or_else(|| sqlx::Error::Decode("Invalid identity transport".into()))?,
                from_email: row.from_email,
                from_name: row.from_name,
                smtp_host: row.smtp_host,
                smtp_port: port(row.smtp_port),
                imap_host: row.imap_host,
                imap_port: port(row.imap_port),
                username: row.username,
                verified_at: row.verified_at,
                created_at: row.created_at,
            },
            user_id: row.user_id,
            secret: EncryptedSecret {
                ciphertext: row.secret_ciphertext,
                encryption_version: row.encryption_version,
                kms_key_id: row.kms_key_id,
            },
        })
    }
}

impl<Database: Send + Sync + 'static> IdentityRepo for PgCampaignRepo<Database> {
    type Error = sqlx::Error;

    async fn list_identities(&self, user_id: &str) -> Result<Vec<StoredIdentity>, Self::Error> {
        sqlx::query_as!(
            IdentityRow,
            "SELECT id, user_id, transport, from_email, from_name, smtp_host, smtp_port, imap_host,
                    imap_port, username, secret_ciphertext, encryption_version, kms_key_id,
                    verified_at, created_at
             FROM campaign_sending_identities WHERE user_id = $1 ORDER BY created_at",
            user_id
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(StoredIdentity::try_from)
        .collect()
    }

    async fn get_identity(&self, id: Uuid) -> Result<Option<StoredIdentity>, Self::Error> {
        sqlx::query_as!(
            IdentityRow,
            "SELECT id, user_id, transport, from_email, from_name, smtp_host, smtp_port, imap_host,
                    imap_port, username, secret_ciphertext, encryption_version, kms_key_id,
                    verified_at, created_at
             FROM campaign_sending_identities WHERE id = $1",
            id
        )
        .fetch_optional(&self.pool)
        .await?
        .map(StoredIdentity::try_from)
        .transpose()
    }

    #[tracing::instrument(skip_all, fields(identity_id = %stored.identity.id), err)]
    async fn upsert_identity(&self, stored: &StoredIdentity) -> Result<StoredIdentity, Self::Error> {
        let identity = &stored.identity;
        // Replacing a mailbox's login restarts its IMAP reply cursor.
        sqlx::query_as!(
            IdentityRow,
            "INSERT INTO campaign_sending_identities AS i
                 (id, user_id, transport, from_email, from_name, smtp_host, smtp_port, imap_host,
                  imap_port, username, secret_ciphertext, encryption_version, kms_key_id, verified_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (user_id, from_email) DO UPDATE SET
                 transport = EXCLUDED.transport,
                 from_name = EXCLUDED.from_name,
                 smtp_host = EXCLUDED.smtp_host,
                 smtp_port = EXCLUDED.smtp_port,
                 imap_host = EXCLUDED.imap_host,
                 imap_port = EXCLUDED.imap_port,
                 username = EXCLUDED.username,
                 secret_ciphertext = EXCLUDED.secret_ciphertext,
                 encryption_version = EXCLUDED.encryption_version,
                 kms_key_id = EXCLUDED.kms_key_id,
                 verified_at = EXCLUDED.verified_at,
                 imap_uid_validity = CASE
                     WHEN i.imap_host IS DISTINCT FROM EXCLUDED.imap_host
                       OR i.username IS DISTINCT FROM EXCLUDED.username THEN NULL
                     ELSE i.imap_uid_validity END,
                 imap_last_uid = CASE
                     WHEN i.imap_host IS DISTINCT FROM EXCLUDED.imap_host
                       OR i.username IS DISTINCT FROM EXCLUDED.username THEN NULL
                     ELSE i.imap_last_uid END,
                 updated_at = now()
             RETURNING id, user_id, transport, from_email, from_name, smtp_host, smtp_port, imap_host,
                       imap_port, username, secret_ciphertext, encryption_version, kms_key_id,
                       verified_at, created_at",
            identity.id,
            stored.user_id,
            identity.transport.as_str(),
            identity.from_email,
            identity.from_name,
            identity.smtp_host,
            identity.smtp_port.map(i32::from),
            identity.imap_host,
            identity.imap_port.map(i32::from),
            identity.username,
            stored.secret.ciphertext,
            stored.secret.encryption_version,
            stored.secret.kms_key_id,
            identity.verified_at,
        )
        .fetch_one(&self.pool)
        .await?
        .try_into()
    }

    async fn delete_identity(&self, user_id: &str, id: Uuid) -> Result<bool, Self::Error> {
        // Campaign rotations drop the mailbox by cascade; past sends keep
        // their rows with the identity cleared.
        Ok(sqlx::query!(
            "DELETE FROM campaign_sending_identities WHERE id = $1 AND user_id = $2",
            id,
            user_id
        )
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }
}
