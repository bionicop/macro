//! SMTP and SendGrid identities: checked with the provider, then stored
//! encrypted to their owner.

use super::models::{
    CampaignError, CreateSendingIdentity, IdentityCredentials, IdentityTransport,
    SendingIdentity, StoredIdentity,
};
use super::ports::{IdentityRepo, Outbox, SecretCipher};
use super::service::storage;
use chrono::Utc;
use macro_user_id::user_id::MacroUserIdStr;
use uuid::Uuid;

/// SMTP submission ports a user may name; others are refused so the server
/// cannot be pointed at arbitrary services.
const SMTP_PORTS: [u16; 4] = [25, 465, 587, 2525];
/// IMAP over implicit TLS.
const IMAP_PORT: u16 = 993;
/// Longest secret accepted.
const MAX_SECRET: usize = 1024;

/// Identity use cases.
pub trait IdentityService: Send + Sync + 'static {
    /// The caller's identities, without secrets.
    fn list(
        &self,
        user: &MacroUserIdStr<'static>,
    ) -> impl Future<Output = Result<Vec<SendingIdentity>, CampaignError>> + Send;
    /// Check the credentials with the provider, then store them encrypted.
    /// The same `From` address replaces the caller's earlier identity.
    fn create(
        &self,
        user: &MacroUserIdStr<'static>,
        input: CreateSendingIdentity,
    ) -> impl Future<Output = Result<SendingIdentity, CampaignError>> + Send;
    /// Delete one of the caller's identities; campaigns stop rotating it.
    fn delete(
        &self,
        user: &MacroUserIdStr<'static>,
        id: Uuid,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
}

/// Identities over storage, a KMS cipher and the provider check. Without a
/// cipher identities can be listed and deleted but not added.
pub struct IdentityServiceImpl<Repo, Cipher, Out> {
    repo: Repo,
    cipher: Option<Cipher>,
    pub(super) outbox: Out,
}

fn host(value: Option<String>, missing: &'static str) -> Result<String, CampaignError> {
    let value = value.map(|host| host.trim().to_ascii_lowercase()).unwrap_or_default();
    if value.is_empty()
        || value.len() > 253
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(CampaignError::Invalid(missing));
    }
    Ok(value)
}

/// Validate and normalize what the user typed.
fn identity(input: &CreateSendingIdentity) -> Result<SendingIdentity, CampaignError> {
    let from_email = input.from_email.trim().to_lowercase();
    match from_email.split_once('@') {
        Some((local, domain)) if !local.is_empty() && domain.contains('.') && from_email.len() <= 320 => {}
        _ => return Err(CampaignError::Invalid("From address is not a valid email address")),
    }
    if input.secret.expose().is_empty() || input.secret.expose().len() > MAX_SECRET {
        return Err(CampaignError::Invalid("Password or API key is required"));
    }
    let from_name = input
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().filter(|c| !c.is_control()).take(100).collect());
    let mut identity = SendingIdentity {
        id: macro_uuid::generate_uuid_v7(),
        transport: input.transport,
        from_email,
        from_name,
        smtp_host: None,
        smtp_port: None,
        imap_host: None,
        imap_port: None,
        username: None,
        verified_at: None,
        created_at: Utc::now(),
    };
    if input.transport == IdentityTransport::Smtp {
        let port = input
            .smtp_port
            .filter(|port| SMTP_PORTS.contains(port))
            .ok_or(CampaignError::Invalid("SMTP port must be 25, 465, 587 or 2525"))?;
        let username = input
            .username
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty() && name.len() <= 320)
            .ok_or(CampaignError::Invalid("SMTP username is required"))?;
        identity.smtp_host = Some(host(input.smtp_host.clone(), "SMTP host is required")?);
        identity.smtp_port = Some(port);
        identity.username = Some(username.to_string());
        if input.imap_host.as_deref().is_some_and(|host| !host.trim().is_empty()) {
            if input.imap_port.is_some_and(|port| port != IMAP_PORT) {
                return Err(CampaignError::Invalid("IMAP port must be 993"));
            }
            identity.imap_host = Some(host(input.imap_host.clone(), "IMAP host is invalid")?);
            identity.imap_port = Some(IMAP_PORT);
        }
    }
    Ok(identity)
}

impl<Repo, Cipher, Out> IdentityServiceImpl<Repo, Cipher, Out> {
    /// Compose at the application root.
    pub fn new(repo: Repo, cipher: Option<Cipher>, outbox: Out) -> Self {
        Self { repo, cipher, outbox }
    }
}

impl<Repo: IdentityRepo, Cipher: SecretCipher, Out> IdentityServiceImpl<Repo, Cipher, Out> {
    /// Decrypted credentials of an identity `owner` holds, for the sender.
    pub async fn credentials(
        &self,
        owner: &str,
        id: Uuid,
    ) -> Result<Option<IdentityCredentials>, CampaignError> {
        let Some(stored) = self.repo.get_identity(id).await.map_err(storage)? else {
            return Ok(None);
        };
        if stored.user_id != owner {
            return Ok(None);
        }
        let cipher = self
            .cipher
            .as_ref()
            .ok_or(CampaignError::Unavailable("Sending identities are not configured"))?;
        let secret = cipher
            .decrypt(&stored.user_id, &stored.secret)
            .await
            .map_err(storage)?;
        Ok(Some(IdentityCredentials {
            identity: stored.identity,
            secret,
        }))
    }
}

impl<Repo, Cipher, Out> IdentityService for IdentityServiceImpl<Repo, Cipher, Out>
where
    Repo: IdentityRepo,
    Cipher: SecretCipher,
    Out: Outbox,
{
    async fn list(&self, user: &MacroUserIdStr<'static>) -> Result<Vec<SendingIdentity>, CampaignError> {
        Ok(self
            .repo
            .list_identities(user.as_ref())
            .await
            .map_err(storage)?
            .into_iter()
            .map(|stored| stored.identity)
            .collect())
    }

    #[tracing::instrument(skip_all, fields(transport = input.transport.as_str()), err)]
    async fn create(
        &self,
        user: &MacroUserIdStr<'static>,
        input: CreateSendingIdentity,
    ) -> Result<SendingIdentity, CampaignError> {
        let cipher = self
            .cipher
            .as_ref()
            .ok_or(CampaignError::Unavailable("Sending identities are not configured"))?;
        let mut identity = identity(&input)?;
        let credentials = IdentityCredentials {
            identity: identity.clone(),
            secret: input.secret,
        };
        self.outbox.verify(&credentials).await?;
        identity.verified_at = Some(Utc::now());
        let secret = cipher
            .encrypt(user.as_ref(), &credentials.secret)
            .await
            .map_err(storage)?;
        let stored = self
            .repo
            .upsert_identity(&StoredIdentity {
                identity,
                user_id: user.as_ref().to_string(),
                secret,
            })
            .await
            .map_err(storage)?;
        Ok(stored.identity)
    }

    async fn delete(&self, user: &MacroUserIdStr<'static>, id: Uuid) -> Result<(), CampaignError> {
        if self
            .repo
            .delete_identity(user.as_ref(), id)
            .await
            .map_err(storage)?
        {
            Ok(())
        } else {
            Err(CampaignError::NotFound)
        }
    }
}
