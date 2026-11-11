//! SendGrid's signed Event Webhook: what SendGrid reports about mail the
//! campaign sender handed it.
//!
//! The scheme (SendGrid "Signed Event Webhook"): the public key is a base64 DER
//! SubjectPublicKeyInfo for P-256; the signature header is a base64 DER ECDSA
//! signature over `timestamp || raw_body` (SHA-256), with the timestamp in a
//! second header. SendGrid's own verifier accepts any timestamp; a replay
//! window is added here. Each send carries `custom_args.campaign_send_id`
//! (see `outbound/sendgrid.rs`), which SendGrid echoes back on every event.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Duration, TimeZone, Utc};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde_json::Value;
use uuid::Uuid;

/// Signature header.
pub const SIGNATURE_HEADER: &str = "x-twilio-email-event-webhook-signature";
/// Timestamp header.
pub const TIMESTAMP_HEADER: &str = "x-twilio-email-event-webhook-timestamp";
/// How far the signed timestamp may differ from now.
pub const REPLAY_WINDOW: Duration = Duration::minutes(5);

/// Why a delivery was refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Rejected {
    /// A header is absent.
    #[error("missing {0} header")]
    Missing(&'static str),
    /// The timestamp is not a time, or is too far from now.
    #[error("timestamp not acceptable")]
    Timestamp,
    /// The signature is malformed or does not match the body.
    #[error("signature does not match")]
    Signature,
}

/// The public key SendGrid shows when the Signed Event Webhook is enabled.
#[derive(Clone)]
pub struct EventKey(VerifyingKey);

impl std::fmt::Debug for EventKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("EventKey").finish_non_exhaustive()
    }
}

impl EventKey {
    /// Parse the base64 DER public key; `None` when blank or not a P-256 key.
    pub fn from_base64(public_key: &str) -> Option<Self> {
        let der = STANDARD.decode(public_key.trim()).ok()?;
        VerifyingKey::from_public_key_der(&der).ok().map(Self)
    }

    /// Check the signature and freshness of one delivery.
    pub fn verify(
        &self,
        signature: Option<&str>,
        timestamp: Option<&str>,
        body: &[u8],
        now: DateTime<Utc>,
    ) -> Result<(), Rejected> {
        let timestamp = timestamp.ok_or(Rejected::Missing(TIMESTAMP_HEADER))?.trim();
        let signature = signature.ok_or(Rejected::Missing(SIGNATURE_HEADER))?.trim();
        let signed_at = timestamp
            .parse::<i64>()
            .ok()
            .and_then(|secs| Utc.timestamp_opt(secs, 0).single())
            .ok_or(Rejected::Timestamp)?;
        if (now - signed_at).abs() > REPLAY_WINDOW {
            return Err(Rejected::Timestamp);
        }
        let der = STANDARD.decode(signature).map_err(|_| Rejected::Signature)?;
        let signature = Signature::from_der(&der).map_err(|_| Rejected::Signature)?;
        let mut signed = timestamp.as_bytes().to_vec();
        signed.extend_from_slice(body);
        self.0.verify(&signed, &signature).map_err(|_| Rejected::Signature)
    }
}

/// What a report means for the recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The address cannot be mailed: a hard bounce, or SendGrid dropped the
    /// message for a known-bad or suppressed address.
    Undeliverable,
    /// The recipient asked not to be mailed: an unsubscribe or a spam report.
    OptedOut,
}

/// One understood report about one send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendEvent {
    /// SendGrid's own id; the same event can be delivered twice.
    pub event_id: String,
    /// The campaign send it is about.
    pub send_id: Uuid,
    /// What to do about it.
    pub outcome: Outcome,
}

/// Parse a verified body. Events that need no action (processed, delivered,
/// deferred, open, click, soft bounces) and items without our `campaign_send_id`
/// are skipped, so one odd item never drops the batch.
pub fn parse(body: &[u8]) -> Result<Vec<SendEvent>, serde_json::Error> {
    let items: Vec<Value> = serde_json::from_slice(body)?;
    Ok(items.iter().filter_map(parse_one).collect())
}

fn parse_one(item: &Value) -> Option<SendEvent> {
    let text = |field: &str| item.get(field).and_then(Value::as_str);
    let outcome = match text("event")? {
        // A soft bounce is `type: "blocked"`; only `bounce` is permanent.
        "bounce" if text("type") == Some("bounce") => Outcome::Undeliverable,
        "dropped" => Outcome::Undeliverable,
        "spamreport" | "unsubscribe" | "group_unsubscribe" => Outcome::OptedOut,
        _ => return None,
    };
    Some(SendEvent {
        event_id: text("sg_event_id")?.to_string(),
        send_id: text("campaign_send_id")?.parse().ok()?,
        outcome,
    })
}

#[cfg(test)]
mod test {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePublicKey;

    fn keys() -> (SigningKey, EventKey) {
        let signing = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let der = signing.verifying_key().to_public_key_der().unwrap();
        let key = EventKey::from_base64(&STANDARD.encode(der.as_bytes())).expect("key parses");
        (signing, key)
    }

    fn sign(signing: &SigningKey, timestamp: &str, body: &[u8]) -> String {
        let mut signed = timestamp.as_bytes().to_vec();
        signed.extend_from_slice(body);
        let signature: Signature = signing.sign(&signed);
        STANDARD.encode(signature.to_der().as_bytes())
    }

    #[test]
    fn a_signed_fresh_body_is_accepted() {
        let (signing, key) = keys();
        let now = Utc.with_ymd_and_hms(2026, 11, 11, 12, 0, 0).unwrap();
        let timestamp = now.timestamp().to_string();
        let body = br#"[{"event":"bounce"}]"#;
        let signature = sign(&signing, &timestamp, body);
        assert_eq!(key.verify(Some(&signature), Some(&timestamp), body, now), Ok(()));
    }

    #[test]
    fn a_changed_body_a_stale_timestamp_or_missing_headers_are_refused() {
        let (signing, key) = keys();
        let now = Utc.with_ymd_and_hms(2026, 11, 11, 12, 0, 0).unwrap();
        let timestamp = now.timestamp().to_string();
        let signature = sign(&signing, &timestamp, b"[]");
        assert_eq!(
            key.verify(Some(&signature), Some(&timestamp), b"[{}]", now),
            Err(Rejected::Signature)
        );
        let old = (now - Duration::minutes(6)).timestamp().to_string();
        let old_signature = sign(&signing, &old, b"[]");
        assert_eq!(
            key.verify(Some(&old_signature), Some(&old), b"[]", now),
            Err(Rejected::Timestamp)
        );
        assert_eq!(
            key.verify(None, Some(&timestamp), b"[]", now),
            Err(Rejected::Missing(SIGNATURE_HEADER))
        );
        assert_eq!(
            key.verify(Some("not base64!"), Some(&timestamp), b"[]", now),
            Err(Rejected::Signature)
        );
        // Another key's signature does not pass.
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let forged = sign(&other, &timestamp, b"[]");
        assert_eq!(
            key.verify(Some(&forged), Some(&timestamp), b"[]", now),
            Err(Rejected::Signature)
        );
    }

    #[test]
    fn a_blank_or_wrong_key_is_not_a_key() {
        assert!(EventKey::from_base64("").is_none());
        assert!(EventKey::from_base64("%%%").is_none());
        assert!(EventKey::from_base64("aGVsbG8=").is_none());
    }

    #[test]
    fn only_events_that_need_action_are_kept() {
        let id = Uuid::from_u128(5);
        let body = serde_json::json!([
            {"event":"bounce","type":"bounce","sg_event_id":"a","campaign_send_id":id.to_string()},
            {"event":"bounce","type":"blocked","sg_event_id":"b","campaign_send_id":id.to_string()},
            {"event":"dropped","sg_event_id":"c","campaign_send_id":id.to_string()},
            {"event":"spamreport","sg_event_id":"d","campaign_send_id":id.to_string()},
            {"event":"unsubscribe","sg_event_id":"e","campaign_send_id":id.to_string()},
            {"event":"delivered","sg_event_id":"f","campaign_send_id":id.to_string()},
            {"event":"open","sg_event_id":"g","campaign_send_id":id.to_string()},
            {"event":"bounce","type":"bounce","sg_event_id":"h"},
            {"event":"dropped","sg_event_id":"i","campaign_send_id":"not-a-uuid"}
        ]);
        let events = parse(body.to_string().as_bytes()).unwrap();
        let kinds: Vec<(&str, Outcome)> = events.iter().map(|e| (e.event_id.as_str(), e.outcome)).collect();
        assert_eq!(
            kinds,
            vec![
                ("a", Outcome::Undeliverable),
                ("c", Outcome::Undeliverable),
                ("d", Outcome::OptedOut),
                ("e", Outcome::OptedOut),
            ]
        );
        assert!(events.iter().all(|e| e.send_id == id));
        assert!(parse(b"not json").is_err());
    }
}
