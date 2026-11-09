//! Links inside campaign email. Recipients are not Macro users, so these
//! routes take no session; each token is an HMAC over the send id and is
//! checked before anything is read or written.

use crate::domain::links::{LinkAction, SignedLinks};
use crate::domain::ports::SenderRepo;
use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use std::sync::Arc;
use uuid::Uuid;

/// Services used by public routes.
pub struct PublicRouterState<R> {
    /// Campaign storage.
    pub repo: Arc<R>,
    /// Link signer; `None` answers every link as not found.
    pub links: Option<SignedLinks>,
}

impl<R> Clone for PublicRouterState<R> {
    fn clone(&self) -> Self {
        Self {
            repo: self.repo.clone(),
            links: self.links.clone(),
        }
    }
}

impl<R> PublicRouterState<R> {
    fn verified(&self, action: LinkAction, send_id: Uuid, token: &str) -> bool {
        self.links
            .as_ref()
            .is_some_and(|links| links.verify(action, send_id, token))
    }
}

/// Merge into the campaign router before it is mounted at `/campaigns`.
pub fn router<R, S>(state: PublicRouterState<R>) -> Router<S>
where
    R: SenderRepo,
    S: Send + Sync + 'static,
{
    Router::new()
        .route(
            "/public/unsubscribe/{send_id}/{token}",
            get(unsubscribe_page::<R>).post(unsubscribe::<R>),
        )
        .route("/public/open/{send_id}/{token}", get(open::<R>))
        .with_state(state)
}

/// A confirm button rather than unsubscribing on GET: mail scanners follow
/// links, and must not unsubscribe anyone by doing so.
#[utoipa::path(get, path = "/campaigns/public/unsubscribe/{send_id}/{token}",
    operation_id = "campaign_unsubscribe_page",
    params(("send_id" = Uuid, Path), ("token" = String, Path)),
    responses((status = 200, content_type = "text/html"), (status = 404)))]
pub async fn unsubscribe_page<R: SenderRepo>(
    State(state): State<PublicRouterState<R>>,
    Path((send_id, token)): Path<(Uuid, String)>,
) -> Response {
    if !state.verified(LinkAction::Unsubscribe, send_id, &token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    page(
        "Unsubscribe",
        r#"<p>Stop receiving these emails?</p>
<form method="post"><button type="submit">Unsubscribe</button></form>"#,
    )
}

/// Unsubscribe. Serves both the confirm form and mail clients' one-click
/// `List-Unsubscribe-Post` (RFC 8058); the body is not needed for either.
#[utoipa::path(post, path = "/campaigns/public/unsubscribe/{send_id}/{token}",
    operation_id = "campaign_unsubscribe",
    params(("send_id" = Uuid, Path), ("token" = String, Path)),
    responses((status = 200, content_type = "text/html"), (status = 404)))]
pub async fn unsubscribe<R: SenderRepo>(
    State(state): State<PublicRouterState<R>>,
    Path((send_id, token)): Path<(Uuid, String)>,
) -> Response {
    if !state.verified(LinkAction::Unsubscribe, send_id, &token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state.repo.unsubscribe(send_id).await {
        // Not found means the campaign was deleted: nothing will be sent.
        Ok(_) => page("Unsubscribed", "<p>You will not receive these emails again.</p>"),
        Err(error) => {
            tracing::error!(%send_id, error = ?error, "campaign unsubscribe failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The open pixel. Always the image, so a bad token or a storage error
/// never shows as a broken image in the recipient's mail.
#[utoipa::path(get, path = "/campaigns/public/open/{send_id}/{token}",
    operation_id = "campaign_open_pixel",
    params(("send_id" = Uuid, Path), ("token" = String, Path)),
    responses((status = 200, content_type = "image/gif")))]
pub async fn open<R: SenderRepo>(
    State(state): State<PublicRouterState<R>>,
    Path((send_id, token)): Path<(Uuid, String)>,
) -> Response {
    if state.verified(LinkAction::Open, send_id, &token)
        && let Err(error) = state.repo.record_open(send_id).await
    {
        tracing::warn!(%send_id, error = ?error, "campaign open not recorded");
    }
    (
        [
            (header::CONTENT_TYPE, "image/gif"),
            (header::CACHE_CONTROL, "no-store, max-age=0"),
        ],
        PIXEL,
    )
        .into_response()
}

/// A transparent 1x1 GIF.
const PIXEL: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
];

fn page(title: &str, body: &str) -> Response {
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>{title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">{body}</body></html>"#
    ))
    .into_response()
}
