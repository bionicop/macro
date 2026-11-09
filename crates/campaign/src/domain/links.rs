//! Signed public links in campaign email: one-click unsubscribe and the open
//! pixel. A link names one send and carries an HMAC so it cannot be forged
//! for another.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

/// Bytes of the HMAC kept in a link.
const TAG_LEN: usize = 16;

/// What a public link does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkAction {
    /// Stop mailing the recipient.
    Unsubscribe,
    /// Record an open.
    Open,
}

impl LinkAction {
    /// Path segment.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsubscribe => "unsubscribe",
            Self::Open => "open",
        }
    }
}

/// Signs and checks public links under one base URL.
#[derive(Clone)]
pub struct SignedLinks {
    base_url: String,
    key: Vec<u8>,
}

impl std::fmt::Debug for SignedLinks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SignedLinks")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl SignedLinks {
    /// Links under `base_url`, the public origin of the campaign routes;
    /// `None` when either is unset or the key is shorter than 32 bytes.
    pub fn new(base_url: &str, key: &str) -> Option<Self> {
        let base_url = base_url.trim().trim_end_matches('/');
        if base_url.is_empty() || key.len() < 32 {
            return None;
        }
        Some(Self {
            base_url: base_url.to_string(),
            key: key.as_bytes().to_vec(),
        })
    }

    fn mac(&self, action: LinkAction, send_id: Uuid) -> Hmac<Sha256> {
        // Keys of any length are valid for HMAC.
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(action.as_str().as_bytes());
        mac.update(b":");
        mac.update(send_id.as_bytes());
        mac
    }

    /// The token for `send_id`.
    pub fn token(&self, action: LinkAction, send_id: Uuid) -> String {
        let tag = self.mac(action, send_id).finalize().into_bytes();
        URL_SAFE_NO_PAD.encode(&tag[..TAG_LEN])
    }

    /// The public URL: `{base}/campaigns/public/{action}/{send_id}/{token}`.
    pub fn url(&self, action: LinkAction, send_id: Uuid) -> String {
        format!(
            "{}/campaigns/public/{}/{}/{}",
            self.base_url,
            action.as_str(),
            send_id,
            self.token(action, send_id)
        )
    }

    /// Whether `token` was issued for `send_id`, compared in constant time.
    pub fn verify(&self, action: LinkAction, send_id: Uuid, token: &str) -> bool {
        let Ok(tag) = URL_SAFE_NO_PAD.decode(token.trim_end_matches(".gif")) else {
            return false;
        };
        tag.len() == TAG_LEN && self.mac(action, send_id).verify_truncated_left(&tag).is_ok()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn links() -> SignedLinks {
        SignedLinks::new("https://api.example.com/", "k".repeat(32).as_str()).expect("configured")
    }

    #[test]
    fn issued_tokens_verify_only_for_their_send_and_action() {
        let links = links();
        let send = Uuid::new_v4();
        let token = links.token(LinkAction::Unsubscribe, send);
        assert!(links.verify(LinkAction::Unsubscribe, send, &token));
        assert!(!links.verify(LinkAction::Open, send, &token));
        assert!(!links.verify(LinkAction::Unsubscribe, Uuid::new_v4(), &token));
        assert!(!links.verify(LinkAction::Unsubscribe, send, "AAAA"));
        assert!(
            links
                .url(LinkAction::Open, send)
                .starts_with("https://api.example.com/campaigns/public/open/")
        );
    }

    #[test]
    fn short_keys_and_missing_origin_disable_links() {
        assert!(SignedLinks::new("", &"k".repeat(32)).is_none());
        assert!(SignedLinks::new("https://api.example.com", "short").is_none());
    }
}
