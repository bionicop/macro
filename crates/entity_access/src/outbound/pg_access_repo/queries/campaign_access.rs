//! Campaign grants, resolved through the caller's current sharing sources.
//! Same shape as `pipeline_access`: `entity_access` rows on a
//! `campaign_entities` row.

use super::SourceIds;
use crate::domain::models::AccessLevel;
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Highest grant on each campaign, including trashed campaigns for restoration.
pub async fn list_campaign_access(
    pool: &PgPool,
    sources: &SourceIds,
) -> Result<Vec<(Uuid, AccessLevel)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT c.id, ea.access_level AS "access_level!: AccessLevel"
           FROM campaign_entities c JOIN entity_access ea ON ea.entity_id = c.id AND ea.entity_type = 'campaign'
           WHERE ea.source_id = ANY($1)"#,
        &sources.0,
    ).fetch_all(pool).await?;
    let mut grants = BTreeMap::<Uuid, AccessLevel>::new();
    for row in rows {
        grants
            .entry(row.id)
            .and_modify(|level| *level = (*level).max(row.access_level))
            .or_insert(row.access_level);
    }
    Ok(grants.into_iter().collect())
}

/// Resolve one campaign without enumerating the caller's other campaigns.
pub async fn get_campaign_access(
    pool: &PgPool,
    id: Uuid,
    sources: &SourceIds,
) -> Result<Option<AccessLevel>, sqlx::Error> {
    let levels = sqlx::query_scalar!(
        "SELECT access_level::text FROM entity_access WHERE entity_id = $1 AND entity_type = 'campaign' AND source_id = ANY($2)",
        id, &sources.0,
    ).fetch_all(pool).await?;
    super::database_access::highest_access_level(&levels)
}
