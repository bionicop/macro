//! Campaign metadata, sequence, senders and progress, composed with the
//! database domain's writer exactly as CRM pipelines are.

use crate::domain::models::{
    Campaign, CampaignBlueprint, CampaignSettings, CampaignSharing, CampaignStats,
    CampaignStatus, DueRecipient, Enrollment, FirstSend, Recipient, RecipientState,
    RecipientUpdate, Reservation, Reserved, SendRecord, SendStatus, Sender, SenderMailbox,
    SenderUsage, SendersOutcome, Step, StepInput, StepStats, StepsOutcome,
};
use crate::domain::ports::{CampaignRepo, SenderRepo};
use chrono::{DateTime, Utc};
use databases::domain::provisioning::DatabaseStorageProvisioner;
use entity_access_db_utils::{AccessLevel, EntityAccessSourceType, EntityType};
use macro_user_id::user_id::MacroUserIdStr;
use models_databases::{ColumnId, DatabaseId, RowId, TableId};
use models_permissions::share_permission::channel_share_permission::{
    ChannelSharePermission, UpdateChannelSharePermission,
};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeSet;
use uuid::Uuid;

/// Campaign persistence errors.
#[derive(Debug, thiserror::Error)]
pub enum CampaignRepoError {
    /// SQL failure rolls back the entire operation.
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    /// Database provisioning failure.
    #[error("Database provisioning failed: {0}")]
    Database(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// Owns only campaign tables; database storage is accessed through its port.
pub struct PgCampaignRepo<Database> {
    pub(super) pool: PgPool,
    database: Database,
}

impl<Database> PgCampaignRepo<Database> {
    /// Construct at the application's composition root.
    pub fn new(pool: PgPool, database: Database) -> Self {
        Self { pool, database }
    }
}

fn decode(message: &'static str) -> sqlx::Error {
    sqlx::Error::Decode(message.into())
}

fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

/// A sender or send row's mailbox columns.
fn mailbox(link_id: Option<Uuid>, identity_id: Option<Uuid>) -> Option<SenderMailbox> {
    match (link_id, identity_id) {
        (Some(link_id), None) => Some(SenderMailbox::Link { link_id }),
        (None, Some(identity_id)) => Some(SenderMailbox::Identity { identity_id }),
        _ => None,
    }
}

fn mailbox_columns(mailbox: SenderMailbox) -> (Option<Uuid>, Option<Uuid>) {
    match mailbox {
        SenderMailbox::Link { link_id } => (Some(link_id), None),
        SenderMailbox::Identity { identity_id } => (None, Some(identity_id)),
    }
}

const MAX_SEND_ATTEMPTS: i16 = crate::domain::models::MAX_SEND_ATTEMPTS as i16;

async fn mark_send(
    tx: &mut Transaction<'static, Postgres>,
    id: Uuid,
    status: SendStatus,
    error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE campaign_sends SET status = $2, error = $3 WHERE id = $1",
        id,
        status.as_str(),
        error,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Lock a live campaign for a policy change in `tx`.
async fn lock_campaign(tx: &mut Transaction<'static, Postgres>, id: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query!("SET LOCAL lock_timeout = '5s'")
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query!(
        "SELECT id FROM campaign_entities WHERE id = $1 AND trashed_at IS NULL FOR NO KEY UPDATE",
        id
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

impl<Database> CampaignRepo for PgCampaignRepo<Database>
where
    Database: DatabaseStorageProvisioner<Transaction = Transaction<'static, Postgres>>,
{
    type Error = CampaignRepoError;
    type Guard = Transaction<'static, Postgres>;

    async fn lock_live(&self, id: Uuid) -> Result<Option<Self::Guard>, Self::Error> {
        let mut tx = self.pool.begin().await?;
        // Readers queued behind a writer also need to release pool connections.
        sqlx::query!("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query!(
            "SELECT id FROM campaign_entities WHERE id = $1 AND trashed_at IS NULL FOR SHARE",
            id
        )
        .fetch_optional(&mut *tx)
        .await?;
        Ok(row.map(|_| tx))
    }

    async fn lock_write(&self, id: Uuid) -> Result<Option<Self::Guard>, Self::Error> {
        let mut tx = self.pool.begin().await?;
        Ok(lock_campaign(&mut tx, id).await?.then_some(tx))
    }

    async fn get_many(&self, ids: &[Uuid]) -> Result<Vec<Campaign>, Self::Error> {
        let rows = sqlx::query!(
            r#"SELECT c.id, c.team_id, c.database_id, c.table_id, c.primary_column_id,
                      c.name, c.user_id, c.status, c.time_zone, c.time_zone_column_id,
                      c.window_start_minute, c.window_end_minute, c.send_days,
                      c.stop_on_reply, c.track_opens, c.launched_at, c.created_at, c.trashed_at,
                      EXISTS (SELECT 1 FROM entity_access ea WHERE ea.entity_id = c.id
                        AND ea.entity_type = 'campaign' AND ea.source_type = 'team'
                        AND ea.source_id = c.team_id::text) AS "team_shared!"
               FROM campaign_entities c
               WHERE c.id = ANY($1) ORDER BY c.id"#,
            ids,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(Campaign {
                    id: row.id,
                    team_id: row.team_id,
                    user_id: row.user_id,
                    name: row.name,
                    status: CampaignStatus::parse(&row.status)
                        .ok_or_else(|| decode("Invalid campaign status"))?,
                    database_id: DatabaseId::from_uuid(row.database_id),
                    table_id: TableId::from_uuid(row.table_id),
                    primary_column_id: ColumnId::from_uuid(row.primary_column_id),
                    sharing: if row.team_shared {
                        CampaignSharing::Team
                    } else {
                        CampaignSharing::Private
                    },
                    settings: CampaignSettings {
                        time_zone: row.time_zone,
                        time_zone_column_id: row.time_zone_column_id.map(ColumnId::from_uuid),
                        window_start_minute: row.window_start_minute as u16,
                        window_end_minute: row.window_end_minute as u16,
                        send_days: row.send_days as u8,
                        stop_on_reply: row.stop_on_reply,
                        track_opens: row.track_opens,
                    },
                    launched_at: row.launched_at,
                    created_at: row.created_at,
                    trashed_at: row.trashed_at,
                })
            })
            .collect()
    }

    #[tracing::instrument(skip_all, err)]
    async fn create(&self, blueprint: &CampaignBlueprint) -> Result<(), Self::Error> {
        let mut tx = self.pool.begin().await?;
        entity_access_db_utils::team_share::acquire_guard(&mut tx).await?;
        self.database
            .create_storage_in(&mut tx, &blueprint.database)
            .await
            .map_err(|error| CampaignRepoError::Database(Box::new(error)))?;
        sqlx::query!(
            "INSERT INTO campaign_entities (id, team_id, database_id, table_id, primary_column_id, time_zone_column_id, name, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            blueprint.id,
            blueprint.team_id,
            blueprint.database.id.into_uuid(),
            blueprint.database.table_id.into_uuid(),
            blueprint.primary_column_id.into_uuid(),
            blueprint.time_zone_column_id.into_uuid(),
            &blueprint.name,
            blueprint.creator.as_ref(),
        )
        .execute(&mut *tx)
        .await?;
        entity_access_db_utils::insert_entity_access_row(
            &mut tx,
            &blueprint.id,
            EntityType::Campaign,
            blueprint.creator.as_ref(),
            EntityAccessSourceType::User,
            AccessLevel::Owner,
        )
        .await?;
        if blueprint.sharing == CampaignSharing::Team {
            entity_access_db_utils::team_share::upsert_direct(
                &mut tx,
                &blueprint.id,
                EntityType::Campaign,
                blueprint.team_id,
                AccessLevel::Edit,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn rename(&self, id: Uuid, name: &str) -> Result<(), Self::Error> {
        sqlx::query!(
            "UPDATE campaign_entities SET name = $2, updated_at = now() WHERE id = $1 AND trashed_at IS NULL",
            id,
            name
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn set_trashed(&self, id: Uuid, trashed: bool) -> Result<(), Self::Error> {
        // A trashed campaign stops sending; restoring leaves it paused.
        sqlx::query!(
            "UPDATE campaign_entities SET trashed_at = CASE WHEN $2 THEN now() ELSE NULL END, status = CASE WHEN $2 AND status = 'active' THEN 'paused' ELSE status END, updated_at = now() WHERE id = $1",
            id,
            trashed
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[tracing::instrument(skip_all, err)]
    async fn share(&self, campaign: &Campaign, sharing: CampaignSharing) -> Result<(), Self::Error> {
        let mut tx = self.pool.begin().await?;
        entity_access_db_utils::team_share::acquire_guard(&mut tx).await?;
        // Serialize sharing with campaign deletion.
        sqlx::query!(
            "SELECT id FROM campaign_entities WHERE id = $1 FOR UPDATE",
            campaign.id
        )
        .fetch_one(&mut *tx)
        .await?;
        match sharing {
            CampaignSharing::Team => {
                entity_access_db_utils::team_share::upsert_direct(
                    &mut tx,
                    &campaign.id,
                    EntityType::Campaign,
                    campaign.team_id,
                    AccessLevel::Edit,
                )
                .await?
            }
            CampaignSharing::Private => {
                entity_access_db_utils::team_share::delete_direct(
                    &mut tx,
                    &campaign.id,
                    EntityType::Campaign,
                    campaign.team_id,
                )
                .await?
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn channel_grants(&self, id: Uuid) -> Result<Vec<ChannelSharePermission>, Self::Error> {
        Ok(
            entity_access_db_utils::get_direct_channel_grants(&self.pool, &id, EntityType::Campaign)
                .await?,
        )
    }

    #[tracing::instrument(skip_all, err)]
    async fn update_channel_grants(
        &self,
        id: Uuid,
        grants: &[UpdateChannelSharePermission],
    ) -> Result<bool, Self::Error> {
        // The live lock serializes sharing with trash and deletion.
        let Some(mut tx) = self.lock_live(id).await? else {
            return Ok(false);
        };
        entity_access_db_utils::update_entity_access_channel_share_permissions(
            &mut tx,
            &id,
            EntityType::Campaign,
            grants,
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn update_settings(&self, id: Uuid, settings: &CampaignSettings) -> Result<(), Self::Error> {
        sqlx::query!(
            "UPDATE campaign_entities SET time_zone = $2, time_zone_column_id = $3, window_start_minute = $4, window_end_minute = $5, send_days = $6, stop_on_reply = $7, track_opens = $8, updated_at = now() WHERE id = $1 AND trashed_at IS NULL",
            id,
            &settings.time_zone,
            settings.time_zone_column_id.map(ColumnId::into_uuid),
            settings.window_start_minute as i16,
            settings.window_end_minute as i16,
            i16::from(settings.send_days),
            settings.stop_on_reply,
            settings.track_opens,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn steps(&self, id: Uuid) -> Result<Vec<Step>, Self::Error> {
        Ok(sqlx::query!(
            "SELECT id, position, delay_minutes, subject, body_html, body_text, body_macro FROM campaign_steps WHERE campaign_id = $1 ORDER BY position",
            id
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| Step {
            id: row.id,
            position: row.position as u16,
            delay_minutes: row.delay_minutes as u32,
            subject: row.subject,
            body_html: row.body_html,
            body_text: row.body_text,
            body_macro: row.body_macro,
        })
        .collect())
    }

    #[tracing::instrument(skip_all, err)]
    async fn replace_steps(&self, id: Uuid, steps: &[StepInput]) -> Result<StepsOutcome, Self::Error> {
        let mut tx = self.pool.begin().await?;
        if !lock_campaign(&mut tx, id).await? {
            return Ok(StepsOutcome::NotLive);
        }
        let existing: BTreeSet<Uuid> = sqlx::query_scalar!(
            "SELECT id FROM campaign_steps WHERE campaign_id = $1",
            id
        )
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
        let kept: BTreeSet<Uuid> = steps.iter().filter_map(|step| step.id).collect();
        if !kept.is_subset(&existing) {
            return Ok(StepsOutcome::UnknownStep);
        }
        let removed: Vec<Uuid> = existing.difference(&kept).copied().collect();
        // Locking the removed steps waits out in-flight reservations, whose
        // foreign keys share-lock them, so the check below cannot go stale.
        let sent = sqlx::query_scalar!(
            r#"SELECT EXISTS (
                 SELECT 1 FROM campaign_sends WHERE step_id IN (
                   SELECT id FROM campaign_steps WHERE id = ANY($1) FOR UPDATE)
               ) AS "sent!""#,
            &removed
        )
        .fetch_one(&mut *tx)
        .await?;
        if sent {
            return Ok(StepsOutcome::SentStepRemoved);
        }
        sqlx::query!("DELETE FROM campaign_steps WHERE id = ANY($1)", &removed)
            .execute(&mut *tx)
            .await?;
        sqlx::query!("SET CONSTRAINTS campaign_steps_position DEFERRED")
            .execute(&mut *tx)
            .await?;
        for (index, step) in steps.iter().enumerate() {
            let position = index as i16 + 1;
            match step.id {
                Some(step_id) => {
                    sqlx::query!(
                        "UPDATE campaign_steps SET position = $2, delay_minutes = $3, subject = $4, body_html = $5, body_text = $6, body_macro = $7, updated_at = now() WHERE id = $1",
                        step_id, position, step.delay_minutes as i32, &step.subject,
                        &step.body_html, step.body_text.as_deref(), step.body_macro.as_deref(),
                    )
                    .execute(&mut *tx)
                    .await?;
                }
                None => {
                    sqlx::query!(
                        "INSERT INTO campaign_steps (id, campaign_id, position, delay_minutes, subject, body_html, body_text, body_macro) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                        macro_uuid::generate_uuid_v7(), id, position, step.delay_minutes as i32,
                        &step.subject, &step.body_html, step.body_text.as_deref(), step.body_macro.as_deref(),
                    )
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(StepsOutcome::Replaced)
    }

    async fn senders(&self, id: Uuid) -> Result<Vec<Sender>, Self::Error> {
        sqlx::query!(
            "SELECT link_id, identity_id, daily_cap FROM campaign_senders WHERE campaign_id = $1 ORDER BY position",
            id
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            let mailbox = match (row.link_id, row.identity_id) {
                (Some(link_id), None) => SenderMailbox::Link { link_id },
                (None, Some(identity_id)) => SenderMailbox::Identity { identity_id },
                _ => return Err(decode("Invalid campaign sender").into()),
            };
            Ok(Sender {
                mailbox,
                daily_cap: row.daily_cap as u32,
            })
        })
        .collect()
    }

    #[tracing::instrument(skip_all, err)]
    async fn replace_senders(
        &self,
        id: Uuid,
        owner: &MacroUserIdStr<'static>,
        senders: &[Sender],
    ) -> Result<SendersOutcome, Self::Error> {
        let mut links = Vec::new();
        let mut identities = Vec::new();
        for sender in senders {
            match sender.mailbox {
                SenderMailbox::Link { link_id } => links.push(link_id),
                SenderMailbox::Identity { identity_id } => identities.push(identity_id),
            }
        }
        let mut tx = self.pool.begin().await?;
        if !lock_campaign(&mut tx, id).await? {
            return Ok(SendersOutcome::NotLive);
        }
        let owned = sqlx::query_scalar!(
            r#"SELECT (SELECT count(*) FROM email_links
                        WHERE id = ANY($2) AND macro_id = $1 AND deleting_at IS NULL)
                    + (SELECT count(*) FROM campaign_sending_identities
                        WHERE id = ANY($3) AND user_id = $1) AS "owned!""#,
            owner.as_ref(),
            &links,
            &identities,
        )
        .fetch_one(&mut *tx)
        .await?;
        if count(owned) != senders.len() as u64 {
            return Ok(SendersOutcome::NotOwned);
        }
        sqlx::query!("DELETE FROM campaign_senders WHERE campaign_id = $1", id)
            .execute(&mut *tx)
            .await?;
        for (index, sender) in senders.iter().enumerate() {
            let (link_id, identity_id) = match sender.mailbox {
                SenderMailbox::Link { link_id } => (Some(link_id), None),
                SenderMailbox::Identity { identity_id } => (None, Some(identity_id)),
            };
            sqlx::query!(
                "INSERT INTO campaign_senders (campaign_id, position, link_id, identity_id, daily_cap) VALUES ($1, $2, $3, $4, $5)",
                id,
                index as i16 + 1,
                link_id,
                identity_id,
                sender.daily_cap as i32,
            )
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(SendersOutcome::Replaced)
    }

    #[tracing::instrument(skip_all, err)]
    async fn transition(
        &self,
        id: Uuid,
        from: &[CampaignStatus],
        to: CampaignStatus,
        confirmation: Option<&str>,
    ) -> Result<bool, Self::Error> {
        let from: Vec<&str> = from.iter().map(|status| status.as_str()).collect();
        let result = sqlx::query!(
            "UPDATE campaign_entities SET status = $3,
                 launched_at = CASE WHEN $3 = 'active' THEN coalesce(launched_at, now()) ELSE launched_at END,
                 launch_confirmation = CASE WHEN $3 = 'active' THEN $4 ELSE launch_confirmation END,
                 updated_at = now()
             WHERE id = $1 AND trashed_at IS NULL AND status = ANY($2)",
            id,
            &from as &[&str],
            to.as_str(),
            confirmation,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    #[tracing::instrument(skip_all, fields(count = recipients.len()), err)]
    async fn enroll(&self, id: Uuid, team_id: Uuid, recipients: &[Enrollment]) -> Result<u64, Self::Error> {
        if recipients.is_empty() {
            return Ok(0);
        }
        let rows: Vec<Uuid> = recipients.iter().map(|r| r.row_id.into_uuid()).collect();
        let contacts: Vec<Uuid> = recipients.iter().map(|r| r.contact_id).collect();
        let emails: Vec<String> = recipients.iter().map(|r| r.email.trim().to_lowercase()).collect();
        let names: Vec<Option<String>> = recipients.iter().map(|r| r.name.clone()).collect();
        let zones: Vec<Option<String>> = recipients.iter().map(|r| r.time_zone.clone()).collect();
        let due: Vec<_> = recipients.iter().map(|r| r.next_send_at).collect();
        // One recipient per address: a contact in two rows is mailed once, and
        // suppressed addresses are never enrolled.
        let result = sqlx::query!(
            r#"INSERT INTO campaign_recipients (campaign_id, row_id, contact_id, email, name, time_zone, next_send_at)
               SELECT DISTINCT ON (r.email) $1, r.row_id, r.contact_id, r.email, r.name, r.time_zone, r.next_send_at
               FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
                 AS r(row_id, contact_id, email, name, time_zone, next_send_at)
               WHERE NOT EXISTS (SELECT 1 FROM campaign_suppressions s WHERE s.team_id = $2 AND s.email = r.email)
                 AND NOT EXISTS (SELECT 1 FROM campaign_recipients e WHERE e.campaign_id = $1 AND e.email = r.email)
               ORDER BY r.email, r.row_id
               ON CONFLICT DO NOTHING"#,
            id,
            team_id,
            &rows,
            &contacts,
            &emails,
            &names as &[Option<String>],
            &zones as &[Option<String>],
            &due,
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    async fn recipients(
        &self,
        id: Uuid,
        after: Option<RowId>,
        limit: u32,
    ) -> Result<Vec<Recipient>, Self::Error> {
        sqlx::query!(
            "SELECT row_id, contact_id, email, name, time_zone, state, next_position, next_send_at, enrolled_at
             FROM campaign_recipients
             WHERE campaign_id = $1 AND ($2::uuid IS NULL OR row_id > $2)
             ORDER BY row_id LIMIT $3",
            id,
            after.map(RowId::into_uuid),
            i64::from(limit),
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(Recipient {
                row_id: RowId::from_uuid(row.row_id),
                contact_id: row.contact_id,
                email: row.email,
                name: row.name,
                time_zone: row.time_zone,
                state: RecipientState::parse(&row.state)
                    .ok_or_else(|| decode("Invalid recipient state"))?,
                next_position: row.next_position as u16,
                next_send_at: row.next_send_at,
                enrolled_at: row.enrolled_at,
            })
        })
        .collect()
    }

    async fn remove_recipients(&self, id: Uuid, rows: &[RowId]) -> Result<u64, Self::Error> {
        let rows: Vec<Uuid> = rows.iter().map(|row| row.into_uuid()).collect();
        Ok(sqlx::query!(
            "UPDATE campaign_recipients SET state = 'removed', next_send_at = NULL, updated_at = now()
             WHERE campaign_id = $1 AND row_id = ANY($2) AND state = 'active'",
            id,
            &rows
        )
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    async fn stats(&self, id: Uuid) -> Result<CampaignStats, Self::Error> {
        let recipients = sqlx::query!(
            r#"SELECT count(*) AS "enrolled!",
                      count(*) FILTER (WHERE state = 'active') AS "active!",
                      count(*) FILTER (WHERE state = 'completed') AS "completed!",
                      count(*) FILTER (WHERE state = 'replied') AS "replied!",
                      count(*) FILTER (WHERE state = 'bounced') AS "bounced!",
                      count(*) FILTER (WHERE state = 'unsubscribed') AS "unsubscribed!",
                      count(*) FILTER (WHERE state = 'failed') AS "failed!"
               FROM campaign_recipients WHERE campaign_id = $1"#,
            id
        )
        .fetch_one(&self.pool)
        .await?;
        let steps = sqlx::query!(
            r#"SELECT st.id AS "step_id!",
                      count(se.id) FILTER (WHERE se.status = 'sent') AS "sent!",
                      count(se.opened_at) AS "opened!",
                      count(se.replied_at) AS "replied!",
                      count(se.bounced_at) AS "bounced!"
               FROM campaign_steps st
               LEFT JOIN campaign_sends se ON se.step_id = st.id
               WHERE st.campaign_id = $1
               GROUP BY st.id, st.position ORDER BY st.position"#,
            id
        )
        .fetch_all(&self.pool)
        .await?;
        let steps: Vec<StepStats> = steps
            .into_iter()
            .map(|row| StepStats {
                step_id: row.step_id,
                sent: count(row.sent),
                opened: count(row.opened),
                replied: count(row.replied),
                bounced: count(row.bounced),
            })
            .collect();
        Ok(CampaignStats {
            enrolled: count(recipients.enrolled),
            active: count(recipients.active),
            completed: count(recipients.completed),
            replied: count(recipients.replied),
            bounced: count(recipients.bounced),
            unsubscribed: count(recipients.unsubscribed),
            failed: count(recipients.failed),
            sent: steps.iter().map(|step| step.sent).sum(),
            opened: steps.iter().map(|step| step.opened).sum(),
            steps,
        })
    }
}

impl<Database> SenderRepo for PgCampaignRepo<Database>
where
    Database: DatabaseStorageProvisioner<Transaction = Transaction<'static, Postgres>>,
{
    async fn active_campaigns(&self) -> Result<Vec<Uuid>, Self::Error> {
        Ok(sqlx::query_scalar!(
            "SELECT id FROM campaign_entities WHERE status = 'active' AND trashed_at IS NULL"
        )
        .fetch_all(&self.pool)
        .await?)
    }

    #[tracing::instrument(skip(self), err)]
    async fn claim_due(
        &self,
        now: DateTime<Utc>,
        lease_until: DateTime<Utc>,
        limit: u32,
    ) -> Result<Vec<DueRecipient>, Self::Error> {
        // The lease moves next_send_at past the batch, so a crashed worker's
        // recipients come due again once it expires.
        let rows = sqlx::query!(
            r#"WITH due AS (
                   SELECT r.campaign_id, r.row_id
                   FROM campaign_recipients r
                   JOIN campaign_entities c ON c.id = r.campaign_id
                   WHERE r.state = 'active' AND r.next_send_at <= $1
                     AND c.status = 'active' AND c.trashed_at IS NULL
                   ORDER BY r.next_send_at
                   LIMIT $3
                   FOR UPDATE OF r SKIP LOCKED
               ), leased AS (
                   UPDATE campaign_recipients r SET next_send_at = $2, updated_at = now()
                   FROM due WHERE r.campaign_id = due.campaign_id AND r.row_id = due.row_id
                   RETURNING r.campaign_id, r.row_id, r.email, r.name, r.time_zone,
                             r.next_position, r.send_attempts
               )
               SELECT l.campaign_id AS "campaign_id!", l.row_id AS "row_id!", l.email AS "email!",
                      l.name, l.time_zone, l.next_position AS "next_position!",
                      l.send_attempts AS "send_attempts!",
                      f.id AS "first_id?", f.link_id AS "first_link_id?",
                      f.identity_id AS "first_identity_id?",
                      f.email_message_id AS "first_email_message_id?",
                      f.rfc_message_id AS "first_rfc_message_id?", f.subject AS "first_subject?"
               FROM leased l
               LEFT JOIN LATERAL (
                   SELECT se.id, se.link_id, se.identity_id, se.email_message_id,
                          se.rfc_message_id, se.subject
                   FROM campaign_sends se JOIN campaign_steps st ON st.id = se.step_id
                   WHERE se.campaign_id = l.campaign_id AND se.recipient_email = l.email
                     AND se.status = 'sent'
                   ORDER BY st.position LIMIT 1
               ) f ON true"#,
            now,
            lease_until,
            i64::from(limit),
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| DueRecipient {
                campaign_id: row.campaign_id,
                row_id: RowId::from_uuid(row.row_id),
                email: row.email,
                name: row.name,
                time_zone: row.time_zone,
                position: row.next_position as u16,
                send_attempts: row.send_attempts as u16,
                first: row.first_id.map(|_| FirstSend {
                    mailbox: mailbox(row.first_link_id, row.first_identity_id),
                    email_message_id: row.first_email_message_id,
                    rfc_message_id: row.first_rfc_message_id,
                    subject: row.first_subject,
                }),
            })
            .collect())
    }

    async fn sender_usage(&self, id: Uuid, since: DateTime<Utc>) -> Result<Vec<SenderUsage>, Self::Error> {
        sqlx::query!(
            r#"SELECT s.link_id, s.identity_id, s.daily_cap,
                      coalesce(l.macro_id, i.user_id) AS owner,
                      (SELECT count(*) FROM campaign_sends se
                        WHERE se.campaign_id = s.campaign_id AND se.reserved_at >= $2
                          AND se.status <> 'failed'
                          AND (se.link_id = s.link_id OR se.identity_id = s.identity_id)) AS "sent_today!"
               FROM campaign_senders s
               LEFT JOIN email_links l ON l.id = s.link_id AND l.deleting_at IS NULL
               LEFT JOIN campaign_sending_identities i ON i.id = s.identity_id
               WHERE s.campaign_id = $1
               ORDER BY s.position"#,
            id,
            since,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(SenderUsage {
                sender: Sender {
                    mailbox: mailbox(row.link_id, row.identity_id)
                        .ok_or_else(|| decode("Invalid campaign sender"))?,
                    daily_cap: row.daily_cap as u32,
                },
                owner: row.owner,
                sent_today: u32::try_from(row.sent_today).unwrap_or(u32::MAX),
            })
        })
        .collect()
    }

    #[tracing::instrument(skip_all, fields(send_id = %reservation.id), err)]
    async fn reserve(&self, reservation: &Reservation) -> Result<Reserved, Self::Error> {
        let (link_id, identity_id) = mailbox_columns(reservation.mailbox);
        let inserted = sqlx::query!(
            "INSERT INTO campaign_sends
                 (id, campaign_id, step_id, row_id, recipient_email, link_id, identity_id, rfc_message_id, subject)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (campaign_id, step_id, recipient_email) DO NOTHING",
            reservation.id,
            reservation.campaign_id,
            reservation.step_id,
            reservation.row_id.into_uuid(),
            reservation.recipient_email,
            link_id,
            identity_id,
            reservation.rfc_message_id,
            reservation.subject,
        )
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1;
        if inserted {
            return Ok(Reserved {
                id: reservation.id,
                inserted,
                status: SendStatus::Reserved,
                mailbox: Some(reservation.mailbox),
                rfc_message_id: reservation.rfc_message_id.clone(),
            });
        }
        let row = sqlx::query!(
            "SELECT id, status, link_id, identity_id, rfc_message_id FROM campaign_sends
             WHERE campaign_id = $1 AND step_id = $2 AND recipient_email = $3",
            reservation.campaign_id,
            reservation.step_id,
            reservation.recipient_email,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(Reserved {
            id: row.id,
            inserted,
            status: SendStatus::parse(&row.status).ok_or_else(|| decode("Invalid send status"))?,
            mailbox: mailbox(row.link_id, row.identity_id),
            rfc_message_id: row.rfc_message_id,
        })
    }

    #[tracing::instrument(skip(self, send), err)]
    async fn finalize(
        &self,
        send: Option<(Uuid, SendRecord)>,
        id: Uuid,
        row_id: RowId,
        claimed_position: u16,
        update: RecipientUpdate,
    ) -> Result<(), Self::Error> {
        let mut tx = self.pool.begin().await?;
        if let Some((send_id, record)) = send {
            match record {
                SendRecord::Sent {
                    email_message_id,
                    rfc_message_id,
                } => {
                    sqlx::query!(
                        "UPDATE campaign_sends SET status = 'sent', error = NULL, sent_at = now(),
                             email_message_id = coalesce($2, email_message_id),
                             rfc_message_id = coalesce($3, rfc_message_id)
                         WHERE id = $1",
                        send_id,
                        email_message_id,
                        rfc_message_id,
                    )
                    .execute(&mut *tx)
                    .await?;
                }
                SendRecord::Failed(error) => {
                    mark_send(&mut tx, send_id, SendStatus::Failed, &error).await?;
                }
                SendRecord::Uncertain(error) => {
                    mark_send(&mut tx, send_id, SendStatus::Uncertain, &error).await?;
                }
                SendRecord::Withdrawn => {
                    sqlx::query!(
                        "DELETE FROM campaign_sends WHERE id = $1 AND status = 'reserved'",
                        send_id
                    )
                    .execute(&mut *tx)
                    .await?;
                }
                SendRecord::Unchanged => {}
            }
        }
        // A recipient who replied, unsubscribed or was removed meanwhile keeps
        // that state; only the claimed step moves on.
        let row_id = row_id.into_uuid();
        let claimed = claimed_position as i16;
        match update {
            RecipientUpdate::Advance { position, at } => {
                sqlx::query!(
                    "UPDATE campaign_recipients
                     SET next_position = $4, next_send_at = $5, send_attempts = 0,
                         state = CASE WHEN $5::timestamptz IS NULL THEN 'completed' ELSE state END,
                         updated_at = now()
                     WHERE campaign_id = $1 AND row_id = $2 AND state = 'active' AND next_position = $3",
                    id,
                    row_id,
                    claimed,
                    position as i16,
                    at,
                )
                .execute(&mut *tx)
                .await?;
            }
            RecipientUpdate::Fail => {
                sqlx::query!(
                    "UPDATE campaign_recipients SET state = 'failed', next_send_at = NULL, updated_at = now()
                     WHERE campaign_id = $1 AND row_id = $2 AND state = 'active' AND next_position = $3",
                    id,
                    row_id,
                    claimed,
                )
                .execute(&mut *tx)
                .await?;
            }
            RecipientUpdate::Retry { at } => {
                sqlx::query!(
                    "UPDATE campaign_recipients
                     SET send_attempts = send_attempts + 1,
                         state = CASE WHEN send_attempts + 1 >= $5 THEN 'failed' ELSE state END,
                         next_send_at = CASE WHEN send_attempts + 1 >= $5 THEN NULL ELSE $4 END,
                         updated_at = now()
                     WHERE campaign_id = $1 AND row_id = $2 AND state = 'active' AND next_position = $3",
                    id,
                    row_id,
                    claimed,
                    at,
                    MAX_SEND_ATTEMPTS,
                )
                .execute(&mut *tx)
                .await?;
            }
            RecipientUpdate::Defer { at } => {
                sqlx::query!(
                    "UPDATE campaign_recipients SET next_send_at = $4, updated_at = now()
                     WHERE campaign_id = $1 AND row_id = $2 AND state = 'active' AND next_position = $3",
                    id,
                    row_id,
                    claimed,
                    at,
                )
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn complete_if_done(&self, id: Uuid) -> Result<bool, Self::Error> {
        // A campaign with nobody enrolled yet is still waiting for rows.
        Ok(sqlx::query!(
            "UPDATE campaign_entities SET status = 'completed', updated_at = now()
             WHERE id = $1 AND status = 'active' AND trashed_at IS NULL
               AND EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = $1)
               AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND state = 'active')",
            id
        )
        .execute(&self.pool)
        .await?
        .rows_affected()
            == 1)
    }

    async fn detect_replies(&self, since: DateTime<Utc>) -> Result<u64, Self::Error> {
        // Any inbound message from the recipient's address after the send,
        // in any inbox the campaign's owner connected, is a reply.
        let marked = sqlx::query_scalar!(
            r#"WITH replied AS (
                   SELECT DISTINCT s.id
                   FROM campaign_sends s
                   JOIN campaign_entities c ON c.id = s.campaign_id
                   JOIN email_links l ON l.macro_id = c.user_id AND l.deleting_at IS NULL
                   JOIN email_contacts ec ON ec.link_id = l.id AND lower(ec.email_address) = lower(s.recipient_email)
                   JOIN email_messages m ON m.from_contact_id = ec.id
                   WHERE s.status = 'sent' AND s.replied_at IS NULL AND s.sent_at > $1
                     AND NOT m.is_sent AND NOT m.is_draft AND m.internal_date_ts > s.sent_at
               ), marked AS (
                   UPDATE campaign_sends s SET replied_at = now()
                   FROM replied r WHERE s.id = r.id
                   RETURNING s.campaign_id, s.row_id
               ), stopped AS (
                   UPDATE campaign_recipients r SET state = 'replied', next_send_at = NULL, updated_at = now()
                   FROM marked m JOIN campaign_entities c ON c.id = m.campaign_id
                   WHERE r.campaign_id = m.campaign_id AND r.row_id = m.row_id
                     AND r.state = 'active' AND c.stop_on_reply
                   RETURNING 1
               )
               SELECT count(*) AS "marked!" FROM marked"#,
            since
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(marked as u64)
    }

    async fn detect_bounces(&self, since: DateTime<Utc>) -> Result<u64, Self::Error> {
        // A delivery report from a mail server: in the sent message's thread
        // for inbox sends, or quoting the Message-ID for identity sends.
        let marked = sqlx::query_scalar!(
            r#"WITH bounced AS (
                   SELECT DISTINCT s.id
                   FROM campaign_sends s
                   JOIN campaign_entities c ON c.id = s.campaign_id
                   JOIN email_links l ON l.macro_id = c.user_id AND l.deleting_at IS NULL
                   JOIN email_messages m ON m.link_id = l.id AND NOT m.is_sent AND NOT m.is_draft
                     AND m.internal_date_ts > s.sent_at
                   JOIN email_contacts ec ON ec.id = m.from_contact_id
                     AND (lower(ec.email_address) LIKE 'mailer-daemon@%' OR lower(ec.email_address) LIKE 'postmaster@%')
                   LEFT JOIN email_messages sent ON sent.id = s.email_message_id
                   WHERE s.status = 'sent' AND s.bounced_at IS NULL AND s.sent_at > $1
                     AND (m.thread_id = sent.thread_id
                       OR (s.rfc_message_id IS NOT NULL
                           AND strpos(m.body_text, trim(both '<>' from s.rfc_message_id)) > 0))
               ), marked AS (
                   UPDATE campaign_sends s SET bounced_at = now()
                   FROM bounced b WHERE s.id = b.id
                   RETURNING s.campaign_id, s.row_id, s.recipient_email
               ), stopped AS (
                   UPDATE campaign_recipients r SET state = 'bounced', next_send_at = NULL, updated_at = now()
                   FROM marked m
                   WHERE r.campaign_id = m.campaign_id AND r.row_id = m.row_id AND r.state = 'active'
                   RETURNING 1
               ), suppressed AS (
                   INSERT INTO campaign_suppressions (team_id, email, reason, campaign_id)
                   SELECT DISTINCT ON (c.team_id, lower(m.recipient_email)) c.team_id, lower(m.recipient_email), 'bounced', m.campaign_id
                   FROM marked m JOIN campaign_entities c ON c.id = m.campaign_id
                   ON CONFLICT DO NOTHING
                   RETURNING 1
               )
               SELECT count(*) AS "marked!" FROM marked"#,
            since
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(marked as u64)
    }

    async fn unsubscribe(&self, send_id: Uuid) -> Result<bool, Self::Error> {
        // Suppressed for the whole team, so no later campaign enrolls them.
        Ok(sqlx::query_scalar!(
            r#"WITH send AS (
                   SELECT s.campaign_id, s.row_id, lower(s.recipient_email) AS email, c.team_id
                   FROM campaign_sends s JOIN campaign_entities c ON c.id = s.campaign_id
                   WHERE s.id = $1
               ), stopped AS (
                   UPDATE campaign_recipients r SET state = 'unsubscribed', next_send_at = NULL, updated_at = now()
                   FROM send WHERE r.campaign_id = send.campaign_id AND r.row_id = send.row_id
                     AND r.state IN ('active', 'completed', 'replied')
                   RETURNING 1
               ), suppressed AS (
                   INSERT INTO campaign_suppressions (team_id, email, reason, campaign_id)
                   SELECT team_id, email, 'unsubscribed', campaign_id FROM send
                   ON CONFLICT DO NOTHING
                   RETURNING 1
               )
               SELECT EXISTS (SELECT 1 FROM send) AS "found!""#,
            send_id
        )
        .fetch_one(&self.pool)
        .await?)
    }

    async fn record_open(&self, send_id: Uuid) -> Result<(), Self::Error> {
        sqlx::query!(
            "UPDATE campaign_sends s SET opened_at = coalesce(s.opened_at, now()), open_count = s.open_count + 1
             FROM campaign_entities c
             WHERE s.id = $1 AND c.id = s.campaign_id AND s.status = 'sent' AND c.track_opens",
            send_id
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
