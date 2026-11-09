//! Thin HTTP adapters, shaped exactly like CRM pipeline routes.

use crate::domain::models::{
    AccessibleCampaign, CampaignError, DeliveryError, CampaignSettings, CampaignSharing, CampaignStats,
    CreateCampaign, LaunchCampaign, LaunchOutcome, Recipients, Sender, Step, StepInput,
};
use crate::domain::service::CampaignService;
use axum::{
    Json, Router,
    extract::{FromRef, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use databases::domain::{
    models::{AppliedOps, CardPosition, OpBatch, TableDetail},
    storage::{StorageRows, StorageRowsQuery},
};
use entity_access::{
    domain::{
        models::{
            EditAccessLevel, EntityAccessReceipt, EntityType, MemberTeamRole, OwnerAccessLevel,
            RequiredPermission, ViewAccessLevel,
        },
        ports::EntityAccessService,
    },
    inbound::axum_extractors::MacroUserTeamExtractorV2,
};
use macro_authorization::{
    MacroAuthorizationExtractor, MacroAuthorizationService, MacroAuthorizationState, UserOrInternal,
};
use models_databases::{RowId, ViewId};
use models_permissions::share_permission::{SharePermissionV2, UpdateSharePermissionRequestV2};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

/// Services used by campaign routes.
pub struct CampaignRouterState<P, E, A> {
    /// Campaign domain service.
    pub service: Arc<P>,
    /// Entity access receipt issuer.
    pub access: Arc<E>,
    /// Authentication state.
    pub authorization: MacroAuthorizationState<A>,
}

impl<P, E, A> Clone for CampaignRouterState<P, E, A> {
    fn clone(&self) -> Self {
        Self {
            service: self.service.clone(),
            access: self.access.clone(),
            authorization: self.authorization.clone(),
        }
    }
}
impl<P, E, A> FromRef<CampaignRouterState<P, E, A>> for Arc<E> {
    fn from_ref(state: &CampaignRouterState<P, E, A>) -> Self {
        state.access.clone()
    }
}
impl<P, E, A> FromRef<CampaignRouterState<P, E, A>> for MacroAuthorizationState<A> {
    fn from_ref(state: &CampaignRouterState<P, E, A>) -> Self {
        state.authorization.clone()
    }
}

/// Mount at `/campaigns`.
pub fn router<P, E, A, S>(state: CampaignRouterState<P, E, A>) -> Router<S>
where
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
    S: Send + Sync + 'static,
{
    Router::new()
        .route("/", get(list::<P, E, A>).post(create::<P, E, A>))
        .route("/{id}", get(read::<P, E, A>))
        .route("/{id}/table", get(table::<P, E, A>))
        .route(
            "/{id}/views/{view}/positions",
            get(view_positions::<P, E, A>),
        )
        .route(
            "/{id}/rows",
            get(rows::<P, E, A>).post(query_rows::<P, E, A>),
        )
        .route("/{id}/ops", post(apply_ops::<P, E, A>))
        .route("/{id}/name", put(rename::<P, E, A>))
        .route("/{id}/sharing", put(share::<P, E, A>))
        .route(
            "/{id}/permissions",
            get(permissions::<P, E, A>).patch(update_permissions::<P, E, A>),
        )
        .route("/{id}/trash", put(trash::<P, E, A>))
        .route("/{id}/settings", put(update_settings::<P, E, A>))
        .route(
            "/{id}/steps",
            get(steps::<P, E, A>).put(set_steps::<P, E, A>),
        )
        .route(
            "/{id}/senders",
            get(senders::<P, E, A>).put(set_senders::<P, E, A>),
        )
        .route("/{id}/launch", post(launch::<P, E, A>))
        .route("/{id}/pause", post(pause::<P, E, A>))
        .route("/{id}/recipients", get(recipients::<P, E, A>))
        .route("/{id}/recipients/remove", post(remove_recipients::<P, E, A>))
        .route("/{id}/stats", get(stats::<P, E, A>))
        .with_state(state)
}

async fn receipt<T: RequiredPermission, E: EntityAccessService, A: MacroAuthorizationService>(
    access: &E,
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    id: Uuid,
) -> Result<EntityAccessReceipt<T>, CampaignError> {
    Ok(access
        .generate_entity_access_receipt::<T>(
            &auth.authorization.user.macro_user_id,
            None,
            &id.to_string(),
            EntityType::Campaign,
        )
        .await?)
}

/// Create a private or team-shared draft campaign.
#[utoipa::path(post, path = "/campaigns", operation_id = "create_campaign", request_body = CreateCampaign,
    responses((status = 200, body = AccessibleCampaign)))]
pub async fn create<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    team: MacroUserTeamExtractorV2<MemberTeamRole, E, A>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Json(input): Json<CreateCampaign>,
) -> Result<Json<AccessibleCampaign>, CampaignError> {
    Ok(Json(
        state
            .service
            .create(team.entity_access_receipt, input)
            .await?,
    ))
}

/// List the caller's live campaigns in their team.
#[utoipa::path(get, path = "/campaigns", operation_id = "list_campaigns",
    responses((status = 200, body = Vec<AccessibleCampaign>)))]
pub async fn list<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    team: MacroUserTeamExtractorV2<MemberTeamRole, E, A>,
    State(state): State<CampaignRouterState<P, E, A>>,
) -> Result<Json<Vec<AccessibleCampaign>>, CampaignError> {
    Ok(Json(state.service.list(team.entity_access_receipt).await?))
}

/// Read one campaign by its entity identity.
#[utoipa::path(get, path = "/campaigns/{id}", operation_id = "get_campaign",
    params(("id" = Uuid, Path)), responses((status = 200, body = AccessibleCampaign)))]
pub async fn read<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<AccessibleCampaign>, CampaignError> {
    Ok(Json(
        state
            .service
            .get(receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

/// Read the recipient table schema.
#[utoipa::path(get, path = "/campaigns/{id}/table", operation_id = "get_campaign_table",
    params(("id" = Uuid, Path)), responses((status = 200, body = TableDetail)))]
pub async fn table<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<TableDetail>, CampaignError> {
    Ok(Json(
        state
            .service
            .table(receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

/// Read saved board positions through campaign access.
#[utoipa::path(get, path = "/campaigns/{id}/views/{view}/positions", operation_id = "get_campaign_view_positions",
    params(("id" = Uuid, Path), ("view" = Uuid, Path)), responses((status = 200, body = Vec<CardPosition>)))]
pub async fn view_positions<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path((id, view)): Path<(Uuid, Uuid)>,
) -> Result<Json<Vec<CardPosition>>, CampaignError> {
    Ok(Json(
        state
            .service
            .view_positions(
                receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?,
                ViewId::from_uuid(view),
            )
            .await?,
    ))
}

/// Pagination through rows.
#[derive(Deserialize, utoipa::IntoParams)]
pub struct RowsQuery {
    /// Continue after this row identity.
    pub after: Option<Uuid>,
}

/// Read recipient rows through campaign access.
#[utoipa::path(get, path = "/campaigns/{id}/rows", operation_id = "get_campaign_rows",
    params(("id" = Uuid, Path), RowsQuery), responses((status = 200, body = StorageRows)))]
pub async fn rows<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Query(query): Query<RowsQuery>,
) -> Result<Json<StorageRows>, CampaignError> {
    Ok(Json(
        state
            .service
            .query_rows(
                receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?,
                StorageRowsQuery {
                    after: query.after.map(RowId::from_uuid),
                    ..Default::default()
                },
            )
            .await?,
    ))
}

/// Query recipient rows using the shared view protocol.
#[utoipa::path(post, path = "/campaigns/{id}/rows", operation_id = "query_campaign_rows",
    request_body = StorageRowsQuery, params(("id" = Uuid, Path)), responses((status = 200, body = StorageRows)))]
pub async fn query_rows<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(query): Json<StorageRowsQuery>,
) -> Result<Json<StorageRows>, CampaignError> {
    Ok(Json(
        state
            .service
            .query_rows(
                receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?,
                query,
            )
            .await?,
    ))
}

/// Edit the recipient table with the common typed operations.
#[utoipa::path(post, path = "/campaigns/{id}/ops", operation_id = "apply_campaign_ops",
    request_body = OpBatch, params(("id" = Uuid, Path)), responses((status = 200, body = AppliedOps)))]
pub async fn apply_ops<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(batch): Json<OpBatch>,
) -> Result<Json<AppliedOps>, CampaignError> {
    Ok(Json(
        state
            .service
            .apply_ops(
                receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
                None,
                batch,
            )
            .await?,
    ))
}

/// Rename input.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameCampaign {
    /// New display name.
    pub name: String,
}
/// Sharing input.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ShareCampaign {
    /// Desired team grant.
    pub sharing: CampaignSharing,
}
/// Trash/restore input.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TrashCampaign {
    /// True to trash; false to restore.
    pub trashed: bool,
}

/// Rename a campaign.
#[utoipa::path(put, path = "/campaigns/{id}/name", operation_id = "rename_campaign", request_body = RenameCampaign,
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn rename<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<RenameCampaign>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .rename(
            receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
            input.name,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Update team sharing.
#[utoipa::path(put, path = "/campaigns/{id}/sharing", operation_id = "share_campaign", request_body = ShareCampaign,
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn share<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<ShareCampaign>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .share(
            receipt::<OwnerAccessLevel, _, _>(&*state.access, auth, id).await?,
            input.sharing,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Read the owner, team grant and channel recipients.
#[utoipa::path(get, path = "/campaigns/{id}/permissions", operation_id = "get_campaign_permissions",
    params(("id" = Uuid, Path)), responses((status = 200, body = SharePermissionV2)))]
pub async fn permissions<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<SharePermissionV2>, CampaignError> {
    Ok(Json(
        state
            .service
            .share_permissions(receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

/// Share with channels, or change or remove their access. Team access
/// changes through `/sharing`; there is no share link.
#[utoipa::path(patch, path = "/campaigns/{id}/permissions", operation_id = "update_campaign_permissions",
    request_body = UpdateSharePermissionRequestV2, params(("id" = Uuid, Path)),
    responses((status = 200, body = SharePermissionV2)))]
pub async fn update_permissions<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(request): Json<UpdateSharePermissionRequestV2>,
) -> Result<Json<SharePermissionV2>, CampaignError> {
    Ok(Json(
        state
            .service
            .update_share_permissions(
                receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
                request,
            )
            .await?,
    ))
}

/// Trash or restore. Trashing an active campaign pauses it.
#[utoipa::path(put, path = "/campaigns/{id}/trash", operation_id = "trash_campaign", request_body = TrashCampaign,
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn trash<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<TrashCampaign>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .set_trashed(
            receipt::<OwnerAccessLevel, _, _>(&*state.access, auth, id).await?,
            input.trashed,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replace the sending window, days and tracking.
#[utoipa::path(put, path = "/campaigns/{id}/settings", operation_id = "update_campaign_settings", request_body = CampaignSettings,
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn update_settings<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(settings): Json<CampaignSettings>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .update_settings(
            receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
            settings,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Read the sequence in order.
#[utoipa::path(get, path = "/campaigns/{id}/steps", operation_id = "get_campaign_steps",
    params(("id" = Uuid, Path)), responses((status = 200, body = Vec<Step>)))]
pub async fn steps<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<Step>>, CampaignError> {
    Ok(Json(
        state
            .service
            .steps(receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

/// Replace the sequence. Keep a step's `id` to edit it; sent steps cannot be
/// removed.
#[utoipa::path(put, path = "/campaigns/{id}/steps", operation_id = "set_campaign_steps", request_body = Vec<StepInput>,
    params(("id" = Uuid, Path)), responses((status = 200, body = Vec<Step>)))]
pub async fn set_steps<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<Vec<StepInput>>,
) -> Result<Json<Vec<Step>>, CampaignError> {
    Ok(Json(
        state
            .service
            .set_steps(
                receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
                input,
            )
            .await?,
    ))
}

/// Read the sender rotation.
#[utoipa::path(get, path = "/campaigns/{id}/senders", operation_id = "get_campaign_senders",
    params(("id" = Uuid, Path)), responses((status = 200, body = Vec<Sender>)))]
pub async fn senders<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<Sender>>, CampaignError> {
    Ok(Json(
        state
            .service
            .senders(receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

/// Replace the sender rotation with the caller's own mailboxes.
#[utoipa::path(put, path = "/campaigns/{id}/senders", operation_id = "set_campaign_senders", request_body = Vec<Sender>,
    params(("id" = Uuid, Path)), responses((status = 200, body = Vec<Sender>)))]
pub async fn set_senders<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<Vec<Sender>>,
) -> Result<Json<Vec<Sender>>, CampaignError> {
    Ok(Json(
        state
            .service
            .set_senders(
                receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
                input,
            )
            .await?,
    ))
}

/// Enroll the table's contacts and start or resume sending.
#[utoipa::path(post, path = "/campaigns/{id}/launch", operation_id = "launch_campaign", request_body = LaunchCampaign,
    params(("id" = Uuid, Path)), responses((status = 200, body = LaunchOutcome)))]
pub async fn launch<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<LaunchCampaign>,
) -> Result<Json<LaunchOutcome>, CampaignError> {
    Ok(Json(
        state
            .service
            .launch(
                receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
                None,
                input,
            )
            .await?,
    ))
}

/// Stop sending; recipients keep their place.
#[utoipa::path(post, path = "/campaigns/{id}/pause", operation_id = "pause_campaign",
    params(("id" = Uuid, Path)), responses((status = 204)))]
pub async fn pause<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, CampaignError> {
    state
        .service
        .pause(receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A page of enrolled recipients.
#[utoipa::path(get, path = "/campaigns/{id}/recipients", operation_id = "get_campaign_recipients",
    params(("id" = Uuid, Path), RowsQuery), responses((status = 200, body = Recipients)))]
pub async fn recipients<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Query(query): Query<RowsQuery>,
) -> Result<Json<Recipients>, CampaignError> {
    Ok(Json(
        state
            .service
            .recipients(
                receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?,
                query.after.map(RowId::from_uuid),
            )
            .await?,
    ))
}

/// Recipients to stop mailing.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveRecipients {
    /// Recipient rows.
    pub row_ids: Vec<Uuid>,
}

/// How many recipients were stopped.
#[derive(Serialize, utoipa::ToSchema)]
pub struct RemovedRecipients {
    /// Recipients whose sequence stopped.
    pub removed: u64,
}

/// Stop these recipients' sequences; their rows stay.
#[utoipa::path(post, path = "/campaigns/{id}/recipients/remove", operation_id = "remove_campaign_recipients",
    request_body = RemoveRecipients, params(("id" = Uuid, Path)), responses((status = 200, body = RemovedRecipients)))]
pub async fn remove_recipients<
    P: CampaignService,
    E: EntityAccessService,
    A: MacroAuthorizationService,
>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
    Json(input): Json<RemoveRecipients>,
) -> Result<Json<RemovedRecipients>, CampaignError> {
    let removed = state
        .service
        .remove_recipients(
            receipt::<EditAccessLevel, _, _>(&*state.access, auth, id).await?,
            input.row_ids.into_iter().map(RowId::from_uuid).collect(),
        )
        .await?;
    Ok(Json(RemovedRecipients { removed }))
}

/// Recipient and send counts.
#[utoipa::path(get, path = "/campaigns/{id}/stats", operation_id = "get_campaign_stats",
    params(("id" = Uuid, Path)), responses((status = 200, body = CampaignStats)))]
pub async fn stats<P: CampaignService, E: EntityAccessService, A: MacroAuthorizationService>(
    auth: MacroAuthorizationExtractor<A, UserOrInternal>,
    State(state): State<CampaignRouterState<P, E, A>>,
    Path(id): Path<Uuid>,
) -> Result<Json<CampaignStats>, CampaignError> {
    Ok(Json(
        state
            .service
            .stats(receipt::<ViewAccessLevel, _, _>(&*state.access, auth, id).await?)
            .await?,
    ))
}

impl IntoResponse for CampaignError {
    fn into_response(self) -> Response {
        let message = |status: StatusCode, message: String| {
            (status, Json(serde_json::json!({ "message": message }))).into_response()
        };
        match self {
            Self::Invalid(text) => message(StatusCode::BAD_REQUEST, text.into()),
            Self::UnknownField(field) => message(
                StatusCode::BAD_REQUEST,
                format!("No column is named \"{field}\"; add one or give a fallback like {{{{{field}|there}}}}"),
            ),
            Self::Conflict(text) => message(StatusCode::CONFLICT, text.into()),
            Self::NotFound => StatusCode::NOT_FOUND.into_response(),
            Self::Access(error) => {
                entity_access::inbound::axum_extractors::ExtractorError::from(error).into_response()
            }
            Self::Database(error) => {
                use databases::domain::models::DatabaseError;
                let status = match error {
                    DatabaseError::InvalidOp(refusal) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "message": refusal.reason,
                                "op": refusal.op,
                                "row": refusal.row,
                                "column": refusal.column,
                                "taken": refusal.taken,
                            })),
                        )
                            .into_response();
                    }
                    DatabaseError::NotFound => StatusCode::NOT_FOUND,
                    DatabaseError::Unauthorized => StatusCode::FORBIDDEN,
                    DatabaseError::InvalidSchemaOperation(_) | DatabaseError::InvalidSharing(_) => {
                        StatusCode::BAD_REQUEST
                    }
                    DatabaseError::RowInUse
                    | DatabaseError::OptionInUse
                    | DatabaseError::VersionConflict => StatusCode::CONFLICT,
                    DatabaseError::Repo(error) => {
                        tracing::error!(error = ?error, "campaign database request failed");
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                };
                message(status, error.to_string())
            }
            Self::Delivery(error) => {
                let status = match error {
                    DeliveryError::Rejected(_) => StatusCode::BAD_REQUEST,
                    DeliveryError::Transient(_) | DeliveryError::Uncertain(_) => StatusCode::BAD_GATEWAY,
                };
                message(status, error.to_string())
            }
            Self::Unavailable(text) => message(StatusCode::SERVICE_UNAVAILABLE, text.into()),
            error => {
                tracing::error!(error = ?error, "campaign request failed");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}
