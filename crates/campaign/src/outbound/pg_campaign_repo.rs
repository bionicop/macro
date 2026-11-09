//! Campaign metadata, sequence, senders and progress, composed with the
//! database domain's writer exactly as CRM pipelines are.

use crate::domain::models::{
    Campaign, CampaignBlueprint, CampaignSettings, CampaignSharing, CampaignStats,
    CampaignStatus, Enrollment, Recipient, RecipientState, Sender, SenderMailbox, SendersOutcome,
    Step, StepInput, StepStats, StepsOutcome,
};
use crate::domain::ports::CampaignRepo;
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
    pool: PgPool,
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
