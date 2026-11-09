//! SMTP identities: a minimal submission client over tokio-rustls.
//!
//! Users name the host, so the server refuses hosts that resolve to private,
//! loopback or link-local addresses and only speaks TLS (implicit on 465,
//! STARTTLS elsewhere): credentials never cross the wire in the clear.
//!
//! What matters for double-send safety is where a failure happens. Before
//! DATA nothing was sent, so errors are transient or a refusal. A reply to
//! the message itself is a definite answer. A broken connection or timeout
//! after the message was written may hide an acceptance, so it is
//! `Uncertain` and the sender never repeats it.

use crate::domain::models::{
    Delivered, DeliveryError, IdentityCredentials, OutboundEmail, SendingIdentity,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mail_builder::MessageBuilder;
use mail_builder::headers::address::Address;
use mail_builder::headers::raw::Raw;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;
use zeroize::Zeroizing;

/// One network step: connect, a command, or the message upload.
const STEP: Duration = Duration::from_secs(30);
/// The message upload and its reply.
const DATA_STEP: Duration = Duration::from_secs(120);
/// Longest reply line accepted, and lines in one reply.
const MAX_LINE: usize = 4096;
const MAX_LINES: usize = 64;

/// Byte stream before or after TLS.
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Sends from SMTP identities. Cheap to clone.
#[derive(Clone)]
pub struct SmtpSender {
    tls: TlsConnector,
}

impl Default for SmtpSender {
    fn default() -> Self {
        Self::new()
    }
}

impl SmtpSender {
    /// Verify servers against the Mozilla roots, like Macro's other outbound
    /// TLS clients.
    pub fn new() -> Self {
        let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(
            rustls::crypto::aws_lc_rs::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .expect("aws-lc-rs supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        Self {
            tls: TlsConnector::from(Arc::new(config)),
        }
    }

    /// Connect and authenticate, then hang up: the credentials work.
    pub async fn verify(&self, credentials: &IdentityCredentials) -> Result<(), DeliveryError> {
        let mut session = self.open(credentials).await?;
        session.quit().await;
        Ok(())
    }

    /// Send one email.
    pub async fn deliver(
        &self,
        credentials: &IdentityCredentials,
        email: &OutboundEmail,
    ) -> Result<Delivered, DeliveryError> {
        let identity = &credentials.identity;
        let from = envelope_address(&identity.from_email)?;
        let to = envelope_address(&email.to_email)?;
        let message = mime(identity, email)?;
        let mut session = self.open(credentials).await?;
        session.expect(&format!("MAIL FROM:<{from}>\r\n"), &[250]).await?;
        session.expect(&format!("RCPT TO:<{to}>\r\n"), &[250, 251]).await?;
        session.expect("DATA\r\n", &[354]).await?;
        session.data(&message).await?;
        session.quit().await;
        Ok(Delivered {
            email_message_id: None,
            rfc_message_id: email.rfc_message_id.clone(),
        })
    }

    async fn open(&self, credentials: &IdentityCredentials) -> Result<Session, DeliveryError> {
        let identity = &credentials.identity;
        let (Some(host), Some(port), Some(username)) = (
            identity.smtp_host.as_deref(),
            identity.smtp_port,
            identity.username.as_deref(),
        ) else {
            return Err(DeliveryError::Rejected("SMTP identity is incomplete".into()));
        };
        let address = resolve(host, port).await?;
        let tcp = step(TcpStream::connect(address)).await?.map_err(io_transient)?;
        let helo = identity
            .from_email
            .rsplit_once('@')
            .map(|(_, domain)| domain.to_string())
            .unwrap_or_else(|| "localhost".into());
        let mut session = if port == 465 {
            let mut session = Session::new(self.tls(host, tcp).await?);
            session.reply(&[220]).await?;
            session.ehlo(&helo).await?;
            session
        } else {
            let mut session = Session::new(Box::new(tcp));
            session.reply(&[220]).await?;
            let capabilities = session.ehlo(&helo).await?;
            if !capabilities.iter().any(|line| line.eq_ignore_ascii_case("STARTTLS")) {
                return Err(DeliveryError::Rejected(
                    "SMTP server does not offer STARTTLS".into(),
                ));
            }
            session.expect("STARTTLS\r\n", &[220]).await?;
            // A server that pipelined bytes after its STARTTLS reply is
            // attempting an injection; they are discarded with the buffer.
            let plain = session.stream.into_inner();
            let mut session = Session::new(self.tls(host, plain).await?);
            session.ehlo(&helo).await?;
            session
        };
        session.authenticate(username, credentials.secret.expose()).await?;
        Ok(session)
    }

    async fn tls<S: Io + 'static>(&self, host: &str, stream: S) -> Result<Box<dyn Io>, DeliveryError> {
        let name = ServerName::try_from(host.to_string())
            .map_err(|_| DeliveryError::Rejected("SMTP host is not a valid name".into()))?;
        let tls = step(self.tls.connect(name, stream))
            .await?
            .map_err(|err| DeliveryError::Rejected(format!("SMTP TLS handshake failed: {err}")))?;
        Ok(Box::new(tls))
    }
}

/// An SMTP conversation.
struct Session {
    stream: BufReader<Box<dyn Io>>,
    /// Whether the message bytes were handed to the server.
    sent_data: bool,
}

/// A server reply.
struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Session {
    fn new(stream: Box<dyn Io>) -> Self {
        Self {
            stream: BufReader::new(stream),
            sent_data: false,
        }
    }

    /// A failure on the wire: uncertain once the message was handed over.
    fn broken(&self, what: impl std::fmt::Display) -> DeliveryError {
        if self.sent_data {
            DeliveryError::Uncertain(format!("SMTP connection lost after the message: {what}"))
        } else {
            DeliveryError::Transient(format!("SMTP connection failed: {what}"))
        }
    }

    async fn read(&mut self) -> Result<Reply, DeliveryError> {
        let mut lines = Vec::new();
        loop {
            let mut line = Vec::new();
            let wait = if self.sent_data { DATA_STEP } else { STEP };
            let result = timeout(
                wait,
                (&mut self.stream).take(MAX_LINE as u64).read_until(b'\n', &mut line),
            )
            .await;
            let read = match result {
                Ok(Ok(read)) => read,
                Ok(Err(err)) => return Err(self.broken(err)),
                Err(_) => return Err(self.broken("timed out")),
            };
            if read == 0 {
                return Err(self.broken("closed by the server"));
            }
            let line = String::from_utf8_lossy(&line).trim_end().to_string();
            let code = line
                .get(..3)
                .and_then(|code| code.parse::<u16>().ok())
                .ok_or_else(|| self.broken("unreadable reply"))?;
            let last = line.as_bytes().get(3) != Some(&b'-');
            lines.push(line.get(4..).unwrap_or_default().to_string());
            if last {
                return Ok(Reply { code, lines });
            }
            if lines.len() >= MAX_LINES {
                return Err(self.broken("reply too long"));
            }
        }
    }

    /// Read a reply and require one of `codes`. Any other reply is the
    /// server's definite answer: 4xx transient, 5xx a refusal.
    async fn reply(&mut self, codes: &[u16]) -> Result<Reply, DeliveryError> {
        let reply = self.read().await?;
        if codes.contains(&reply.code) {
            return Ok(reply);
        }
        let text = format!("SMTP {} {}", reply.code, reply.lines.join(" "));
        Err(if (400..500).contains(&reply.code) {
            DeliveryError::Transient(text)
        } else {
            DeliveryError::Rejected(text)
        })
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), DeliveryError> {
        let wait = if self.sent_data { DATA_STEP } else { STEP };
        let stream = self.stream.get_mut();
        let result = timeout(wait, async {
            stream.write_all(bytes).await?;
            stream.flush().await
        })
        .await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => Err(self.broken(err)),
            Err(_) => Err(self.broken("timed out")),
        }
    }

    async fn expect(&mut self, command: &str, codes: &[u16]) -> Result<Reply, DeliveryError> {
        self.write(command.as_bytes()).await?;
        self.reply(codes).await
    }

    /// EHLO; the extension keywords offered.
    async fn ehlo(&mut self, helo: &str) -> Result<Vec<String>, DeliveryError> {
        let reply = self.expect(&format!("EHLO {helo}\r\n"), &[250]).await?;
        Ok(reply.lines.into_iter().skip(1).collect())
    }

    /// AUTH PLAIN, else AUTH LOGIN. A refused login is a refusal, so a
    /// wrong password fails verification instead of retrying.
    async fn authenticate(&mut self, username: &str, password: &str) -> Result<(), DeliveryError> {
        let plain = Zeroizing::new(format!("\0{username}\0{password}"));
        let command = Zeroizing::new(format!("AUTH PLAIN {}\r\n", STANDARD.encode(plain.as_bytes())));
        self.write(command.as_bytes()).await?;
        let reply = self.read().await?;
        match reply.code {
            235 => return Ok(()),
            // Mechanism not supported: try LOGIN.
            504 | 502 => {}
            code => return Err(auth_failed(code, &reply)),
        }
        self.expect("AUTH LOGIN\r\n", &[334]).await?;
        let user = Zeroizing::new(format!("{}\r\n", STANDARD.encode(username)));
        self.expect(&user, &[334]).await?;
        let pass = Zeroizing::new(format!("{}\r\n", STANDARD.encode(password)));
        self.write(pass.as_bytes()).await?;
        let reply = self.read().await?;
        if reply.code == 235 {
            Ok(())
        } else {
            Err(auth_failed(reply.code, &reply))
        }
    }

    /// Upload the message, dot-stuffed, and read the server's verdict.
    async fn data(&mut self, message: &[u8]) -> Result<(), DeliveryError> {
        let mut body = Vec::with_capacity(message.len() + 64);
        let mut line_start = true;
        for &byte in message {
            if line_start && byte == b'.' {
                body.push(b'.');
            }
            body.push(byte);
            line_start = byte == b'\n';
        }
        if !body.ends_with(b"\r\n") {
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(b".\r\n");
        self.sent_data = true;
        self.write(&body).await?;
        // A definite 4xx/5xx here means the server refused the message.
        self.reply(&[250]).await.map(drop)
    }

    /// Best effort: the outcome is already known.
    async fn quit(&mut self) {
        let _ = timeout(Duration::from_secs(5), async {
            let stream = self.stream.get_mut();
            let _ = stream.write_all(b"QUIT\r\n").await;
            let _ = stream.flush().await;
        })
        .await;
    }
}

fn auth_failed(code: u16, reply: &Reply) -> DeliveryError {
    let text = format!("SMTP login refused: {} {}", code, reply.lines.join(" "));
    if (400..500).contains(&code) {
        DeliveryError::Transient(text)
    } else {
        DeliveryError::Rejected(text)
    }
}

async fn step<F: Future>(future: F) -> Result<F::Output, DeliveryError> {
    timeout(STEP, future)
        .await
        .map_err(|_| DeliveryError::Transient("SMTP server timed out".into()))
}

fn io_transient(err: std::io::Error) -> DeliveryError {
    DeliveryError::Transient(format!("SMTP connection failed: {err}"))
}

/// The first public address of `host`. Any private answer refuses the host,
/// so a name cannot mix a public and an internal address.
async fn resolve(host: &str, port: u16) -> Result<SocketAddr, DeliveryError> {
    let addresses: Vec<SocketAddr> = step(tokio::net::lookup_host((host, port)))
        .await?
        .map_err(|err| DeliveryError::Transient(format!("SMTP host lookup failed: {err}")))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public(address.ip())) {
        return Err(DeliveryError::Rejected(
            "SMTP host must resolve to public addresses".into(),
        ));
    }
    Ok(addresses[0])
}

/// Globally routable unicast.
pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || a == 0
                // Carrier-grade NAT, benchmarking, reserved.
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                // Unique local, link local, documentation.
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}

/// An address safe inside `MAIL FROM:<…>` / `RCPT TO:<…>`.
fn envelope_address(address: &str) -> Result<&str, DeliveryError> {
    let address = address.trim();
    let valid = address.len() <= 320
        && address.contains('@')
        && !address
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '<' || c == '>');
    if valid {
        Ok(address)
    } else {
        Err(DeliveryError::Rejected(format!("Invalid address: {address}")))
    }
}

fn bare_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

/// The RFC 5322 message, with one-click unsubscribe (RFC 8058) when set.
pub(crate) fn mime(identity: &SendingIdentity, email: &OutboundEmail) -> Result<Vec<u8>, DeliveryError> {
    let from = Address::new_address(identity.from_name.clone(), identity.from_email.clone());
    let to = Address::new_address(email.to_name.clone(), email.to_email.clone());
    let mut builder = MessageBuilder::new()
        .from(from)
        .to(to)
        .subject(email.subject.clone())
        .text_body(email.body_text.clone())
        .html_body(email.body_html.clone());
    if let Some(id) = &email.rfc_message_id {
        builder = builder.message_id(bare_id(id));
    }
    if let Some(parent) = &email.in_reply_to {
        builder = builder
            .in_reply_to(bare_id(parent))
            .references(bare_id(parent));
    }
    if let Some(url) = &email.unsubscribe_url {
        builder = builder
            .header("List-Unsubscribe", Raw::new(format!("<{url}>")))
            .header("List-Unsubscribe-Post", Raw::new("List-Unsubscribe=One-Click"));
    }
    builder
        .write_to_vec()
        .map_err(|err| DeliveryError::Rejected(format!("Could not build the message: {err}")))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn refuses_internal_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["142.250.1.108", "2607:f8b0:4004::1b"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn envelope_addresses_cannot_inject_commands() {
        assert!(envelope_address("ada@example.com").is_ok());
        assert!(envelope_address("ada@example.com>\r\nRCPT TO:<eve@example.com").is_err());
        assert!(envelope_address("ada lovelace@example.com").is_err());
    }
}
