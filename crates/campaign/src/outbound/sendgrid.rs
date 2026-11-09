//! SendGrid identities over the v3 Mail Send API. The From address must be a
//! sender verified in the user's SendGrid account; SendGrid refuses others.
//!
//! SendGrid's own click and open tracking are turned off: they rewrite links
//! through SendGrid's domain, and campaigns track opens themselves.

use crate::domain::models::{Delivered, DeliveryError, IdentityCredentials, OutboundEmail};
use reqwest::StatusCode;
use serde_json::{Map, Value, json};
use std::time::Duration;

const API: &str = "https://api.sendgrid.com/v3";

/// Sends from SendGrid identities. Cheap to clone.
#[derive(Clone)]
pub struct SendGridSender {
    http: reqwest::Client,
}

impl Default for SendGridSender {
    fn default() -> Self {
        Self::new()
    }
}

impl SendGridSender {
    /// A client with bounded timeouts.
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client with default TLS builds");
        Self { http }
    }

    /// The key is valid and may send mail.
    pub async fn verify(&self, credentials: &IdentityCredentials) -> Result<(), DeliveryError> {
        let response = self
            .http
            .get(format!("{API}/scopes"))
            .bearer_auth(credentials.secret.expose())
            .send()
            .await
            .map_err(|err| DeliveryError::Transient(format!("SendGrid unreachable: {err}")))?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(DeliveryError::Rejected("SendGrid refused the API key".into()));
            }
            status => {
                return Err(DeliveryError::Transient(format!("SendGrid answered {status}")));
            }
        }
        let body: Value = response
            .json()
            .await
            .map_err(|err| DeliveryError::Transient(format!("SendGrid reply unreadable: {err}")))?;
        let can_send = body["scopes"]
            .as_array()
            .is_some_and(|scopes| scopes.iter().any(|scope| scope == "mail.send"));
        if can_send {
            Ok(())
        } else {
            Err(DeliveryError::Rejected(
                "The SendGrid API key lacks the Mail Send permission".into(),
            ))
        }
    }

    /// Send one email. Acceptance is SendGrid's 202.
    pub async fn deliver(
        &self,
        credentials: &IdentityCredentials,
        email: &OutboundEmail,
    ) -> Result<Delivered, DeliveryError> {
        let response = self
            .http
            .post(format!("{API}/mail/send"))
            .bearer_auth(credentials.secret.expose())
            .json(&payload(credentials, email))
            .send()
            .await
            .map_err(|err| {
                // A refused connection never reached SendGrid; anything later
                // may have.
                if err.is_connect() {
                    DeliveryError::Transient(format!("SendGrid unreachable: {err}"))
                } else {
                    DeliveryError::Uncertain(format!("SendGrid request interrupted: {err}"))
                }
            })?;
        let status = response.status();
        if status == StatusCode::ACCEPTED || status == StatusCode::OK {
            return Ok(Delivered {
                email_message_id: None,
                rfc_message_id: email.rfc_message_id.clone(),
            });
        }
        let detail = response.text().await.unwrap_or_default();
        let detail: String = detail.chars().take(500).collect();
        let text = format!("SendGrid answered {status}: {detail}");
        Err(if status == StatusCode::TOO_MANY_REQUESTS {
            DeliveryError::Transient(text)
        } else if status.is_server_error() {
            DeliveryError::Uncertain(text)
        } else {
            DeliveryError::Rejected(text)
        })
    }
}

fn address(email: &str, name: Option<&str>) -> Value {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => json!({ "email": email, "name": name }),
        None => json!({ "email": email }),
    }
}

/// The Mail Send body.
fn payload(credentials: &IdentityCredentials, email: &OutboundEmail) -> Value {
    let identity = &credentials.identity;
    let mut headers = Map::new();
    if let Some(id) = &email.rfc_message_id {
        headers.insert("Message-ID".into(), id.clone().into());
    }
    if let Some(parent) = &email.in_reply_to {
        headers.insert("In-Reply-To".into(), parent.clone().into());
        headers.insert("References".into(), parent.clone().into());
    }
    if let Some(url) = &email.unsubscribe_url {
        headers.insert("List-Unsubscribe".into(), format!("<{url}>").into());
        headers.insert(
            "List-Unsubscribe-Post".into(),
            "List-Unsubscribe=One-Click".into(),
        );
    }
    let mut body = json!({
        "personalizations": [{
            "to": [address(&email.to_email, email.to_name.as_deref())],
        }],
        "from": address(&identity.from_email, identity.from_name.as_deref()),
        "subject": email.subject,
        "content": [
            { "type": "text/plain", "value": email.body_text },
            { "type": "text/html", "value": email.body_html },
        ],
        // Echoed on SendGrid's event webhook, to match events to sends.
        "custom_args": { "campaign_send_id": email.send_id.to_string() },
        "tracking_settings": {
            "click_tracking": { "enable": false, "enable_text": false },
            "open_tracking": { "enable": false },
            "subscription_tracking": { "enable": false },
        },
    });
    if !headers.is_empty() {
        body["headers"] = Value::Object(headers);
    }
    body
}
