//! A user's SMTP and SendGrid identities. Credentials are the person's own,
//! so only a directly authenticated user may list, add or remove them;
//! internal services and bots cannot.

use crate::domain::identities::IdentityService;
use crate::domain::models::{CampaignError, CreateSendingIdentity, SendingIdentity};
use axum::{
    Json, Router,
    extract::{FromRef, Path, State},
    http::StatusCode,
    routing::{delete, get},
};
use macro_authorization::{
    MacroAuthorizationExtractor, MacroAuthorizationService, MacroAuthorizationState, UserOnly,
};
use std::sync::Arc;
use uuid::Uuid;

/// Services used by identity routes.
pub struct IdentityRouterState<I, A> {
    /// Identity use cases.
    pub service: Arc<I>,
    /// Authentication state.
    pub authorization: MacroAuthorizationState<A>,
}

impl<I, A> Clone for IdentityRouterState<I, A> {
    fn clone(&self) -> Self {
        Self {
            service: self.service.clone(),
            authorization: self.authorization.clone(),
        }
    }
}
impl<I, A> FromRef<IdentityRouterState<I, A>> for MacroAuthorizationState<A> {
    fn from_ref(state: &IdentityRouterState<I, A>) -> Self {
        state.authorization.clone()
    }
}

/// Merge into the campaign router before it is mounted at `/campaigns`.
pub fn router<I, A, S>(state: IdentityRouterState<I, A>) -> Router<S>
where
    I: IdentityService,
    A: MacroAuthorizationService,
    S: Send + Sync + 'static,
{
    Router::new()
        .route("/identities", get(list::<I, A>).post(create::<I, A>))
        .route("/identities/{id}", delete(remove::<I, A>))
        .with_state(state)
}

/// The caller's sending identities, without secrets.
#[utoipa::path(get, path = "/campaigns/identities", operation_id = "list_campaign_identities",
    responses((status = 200, body = Vec<SendingIdentity>)))]
pub async fn list<I: IdentityService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOnly>,
    State(state): State<IdentityRouterState<I, A>>,
) -> Result<Json<Vec<SendingIdentity>>, CampaignError> {
    Ok(Json(state.service.list(&auth.authorization.macro_user_id).await?))
}

/// Check SMTP or SendGrid credentials with the provider, then store them
/// encrypted. A wrong password answers 400; an unreachable server 502.
#[utoipa::path(post, path = "/campaigns/identities", operation_id = "create_campaign_identity",
    request_body = CreateSendingIdentity, responses((status = 200, body = SendingIdentity)))]
pub async fn create<I: IdentityService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOnly>,
    State(state): State<IdentityRouterState<I, A>>,
    Json(input): Json<CreateSendingIdentity>,
) -> Result<Json<SendingIdentity>, CampaignError> {
    Ok(Json(
        state
            .service
            .create(&auth.authorization.macro_user_id, input)
            .await?,
    ))
}

/// Delete one of the caller's identities; campaigns stop sending from it.
#[utoipa::path(delete, path = "/campaigns/identities/{id}", operation_id = "delete_campaign_identity",
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn remove<I: IdentityService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOnly>,
    State(state): State<IdentityRouterState<I, A>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .delete(&auth.authorization.macro_user_id, id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
