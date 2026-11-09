//! Identity secrets under AWS KMS, by the scheme `cursor_api_key` uses:
//! `kms:Encrypt` directly (a password or API key is far inside the 4 KB
//! limit), with an encryption context that binds each ciphertext to its owner
//! and to this purpose. KMS gates every read and enforces the binding.

use crate::domain::models::{EncryptedSecret, Secret};
use crate::domain::ports::SecretCipher;
use aws_sdk_kms::primitives::Blob;
use std::collections::HashMap;

/// The scheme written; stored on every row.
pub const ENCRYPTION_VERSION: i16 = 1;
/// Keeps a ciphertext from another feature from decrypting as a mailbox
/// secret, even under the same key.
const ENCRYPTION_PURPOSE: &str = "campaign-sending-identity";

/// A KMS call failed. Opaque on purpose: the AWS error can tell a wrong
/// context from a missing permission, which is CloudTrail's business.
#[derive(Debug, thiserror::Error)]
#[error("campaign identity kms operation failed")]
pub struct KmsCipherError;

/// Encrypts under one KMS key, which must be separate from every other
/// feature's so IAM can grant decrypt to the sender alone.
#[derive(Clone)]
pub struct KmsSecretCipher {
    client: aws_sdk_kms::Client,
    kms_key_id: String,
}

impl KmsSecretCipher {
    /// Encrypt under `kms_key_id`.
    pub fn new(client: aws_sdk_kms::Client, kms_key_id: String) -> Self {
        Self { client, kms_key_id }
    }
}

/// The context KMS requires to match on decrypt; one constructor so it can
/// never be built two ways.
fn context(owner: &str) -> Result<HashMap<String, String>, KmsCipherError> {
    let owner = owner.trim();
    if owner.is_empty() || owner.contains('\0') {
        return Err(KmsCipherError);
    }
    Ok(HashMap::from([
        ("macro:purpose".to_owned(), ENCRYPTION_PURPOSE.to_owned()),
        ("macro:encryption-version".to_owned(), ENCRYPTION_VERSION.to_string()),
        ("macro:user-id".to_owned(), owner.to_owned()),
    ]))
}

impl SecretCipher for KmsSecretCipher {
    type Error = KmsCipherError;

    async fn encrypt(&self, owner: &str, secret: &Secret) -> Result<EncryptedSecret, Self::Error> {
        let response = self
            .client
            .encrypt()
            .key_id(&self.kms_key_id)
            .plaintext(Blob::new(secret.expose().as_bytes()))
            .set_encryption_context(Some(context(owner)?))
            .send()
            .await
            .map_err(|_| KmsCipherError)?;
        let ciphertext = response.ciphertext_blob.ok_or(KmsCipherError)?;
        Ok(EncryptedSecret {
            ciphertext: ciphertext.into_inner(),
            encryption_version: ENCRYPTION_VERSION,
            // The ARN, even when configured by alias.
            kms_key_id: response.key_id.unwrap_or_else(|| self.kms_key_id.clone()),
        })
    }

    async fn decrypt(&self, owner: &str, secret: &EncryptedSecret) -> Result<Secret, Self::Error> {
        if secret.encryption_version != ENCRYPTION_VERSION {
            return Err(KmsCipherError);
        }
        let response = self
            .client
            .decrypt()
            // Named, so a blob under another key never decrypts here.
            .key_id(&secret.kms_key_id)
            .ciphertext_blob(Blob::new(secret.ciphertext.as_slice()))
            .set_encryption_context(Some(context(owner)?))
            .send()
            .await
            .map_err(|_| KmsCipherError)?;
        let plaintext = zeroize::Zeroizing::new(response.plaintext.ok_or(KmsCipherError)?.into_inner());
        let text = std::str::from_utf8(&plaintext).map_err(|_| KmsCipherError)?;
        Ok(Secret::new(text.to_owned()))
    }
}
