use super::*;
use crate::domain::models::{CampaignBlueprint, MAX_SEND_ATTEMPTS};
use chrono::Duration;
use databases::domain::models::ColumnProtection;
use databases::domain::provisioning::{ProvisionedColumn, StorageBlueprint};
use databases::outbound::pg_cell_store::PgCellStore;
use macro_db_migrator::MACRO_DB_MIGRATIONS;
use macro_user_id::cowlike::CowLike;
use models_properties::{DataType, EntityType as PropertyEntityType};
use properties::outbound::properties_pg_repo::PropertiesPgRepo;

const OWNER: &str = "macro|campaign-repo-owner@example.com";

type Repo = PgCampaignRepo<PgCellStore<PropertiesPgRepo>>;

struct Fixture {
    repo: Repo,
    campaign_id: Uuid,
    team_id: Uuid,
    table_id: Uuid,
    steps: Vec<Uuid>,
    mailbox: SenderMailbox,
}

fn owner() -> MacroUserIdStr<'static> {
    MacroUserIdStr::parse_from_str(OWNER)
        .expect("valid user id")
        .into_owned()
}

fn step(subject: &str) -> StepInput {
    StepInput {
        id: None,
        delay_minutes: 0,
        subject: subject.into(),
        body_html: "<p>Hi</p>".into(),
        body_text: None,
        body_macro: None,
    }
}

async fn seed_team(pool: &PgPool) -> Uuid {
    let team_id = Uuid::now_v7();
    let macro_user_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO macro_user (id, username, email, stripe_customer_id) VALUES ($1, $2, $2, $3)",
    )
    .bind(macro_user_id)
    .bind(OWNER)
    .bind(format!("stripe_{macro_user_id}"))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO "User" (id, email, macro_user_id) VALUES ($1, $1, $2)"#)
        .bind(OWNER)
        .bind(macro_user_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team (id, name, owner_id) VALUES ($1, 'team', $2)")
        .bind(team_id)
        .bind(OWNER)
        .execute(pool)
        .await
        .unwrap();
    team_id
}

/// An active campaign with two steps and one SendGrid identity.
async fn fixture(pool: &PgPool) -> Fixture {
    let team_id = seed_team(pool).await;
    let repo = PgCampaignRepo::new(
        pool.clone(),
        PgCellStore::new(pool.clone(), PropertiesPgRepo::new(pool.clone())),
    );
    let primary_column_id = ColumnId::new();
    let time_zone_column_id = ColumnId::new();
    let blueprint = CampaignBlueprint {
        id: macro_uuid::generate_uuid_v7(),
        team_id,
        sharing: CampaignSharing::Private,
        name: "Launch".into(),
        creator: owner(),
        primary_column_id,
        time_zone_column_id,
        database: StorageBlueprint {
            id: DatabaseId::new(),
            table_id: TableId::new(),
            columns: vec![
                ProvisionedColumn {
                    id: primary_column_id,
                    name: "Contact".into(),
                    data_type: DataType::Entity,
                    entity_type: Some(PropertyEntityType::Contact),
                    options: vec![],
                    nullable: false,
                    protections: vec![ColumnProtection::Delete, ColumnProtection::ChangeType],
                },
                ProvisionedColumn {
                    id: time_zone_column_id,
                    name: "Time zone".into(),
                    data_type: DataType::String,
                    entity_type: None,
                    options: vec![],
                    nullable: true,
                    protections: vec![],
                },
            ],
        },
    };
    repo.create(&blueprint).await.unwrap();
    let campaign_id = blueprint.id;
    assert_eq!(
        repo.replace_steps(campaign_id, &[step("Hello"), step("")])
            .await
            .unwrap(),
        StepsOutcome::Replaced
    );
    let steps = repo
        .steps(campaign_id)
        .await
        .unwrap()
        .into_iter()
        .map(|step| step.id)
        .collect();
    let identity_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO campaign_sending_identities
             (id, user_id, transport, from_email, secret_ciphertext, encryption_version, kms_key_id)
         VALUES ($1, $2, 'sendgrid', 'sender@example.com', '\\x00', 1, 'test')",
    )
    .bind(identity_id)
    .bind(OWNER)
    .execute(pool)
    .await
    .unwrap();
    assert!(
        repo.transition(campaign_id, &[CampaignStatus::Draft], CampaignStatus::Active, None)
            .await
            .unwrap()
    );
    Fixture {
        repo,
        campaign_id,
        team_id,
        table_id: blueprint.database.table_id.into_uuid(),
        steps,
        mailbox: SenderMailbox::Identity { identity_id },
    }
}

async fn row(pool: &PgPool, table_id: Uuid, position: &str) -> RowId {
    let id = RowId::new();
    sqlx::query("INSERT INTO database_rows (id, table_id, position, created_by) VALUES ($1, $2, $3, $4)")
        .bind(id.into_uuid())
        .bind(table_id)
        .bind(position)
        .bind(OWNER)
        .execute(pool)
        .await
        .unwrap();
    id
}

fn enrollment(row_id: RowId, email: &str, due: DateTime<Utc>) -> Enrollment {
    Enrollment {
        row_id,
        contact_id: Uuid::now_v7(),
        email: email.into(),
        name: None,
        time_zone: None,
        next_send_at: due,
    }
}

async fn state(pool: &PgPool, campaign_id: Uuid, row_id: RowId) -> (String, Option<DateTime<Utc>>, i16) {
    sqlx::query_as(
        "SELECT state, next_send_at, send_attempts FROM campaign_recipients WHERE campaign_id = $1 AND row_id = $2",
    )
    .bind(campaign_id)
    .bind(row_id.into_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

/// One enrolled recipient, due now.
async fn enrolled(pool: &PgPool, f: &Fixture) -> RowId {
    let row_id = row(pool, f.table_id, "a0").await;
    let due = Utc::now() - Duration::minutes(1);
    assert_eq!(
        f.repo
            .enroll(f.campaign_id, f.team_id, &[enrollment(row_id, "ada@example.com", due)])
            .await
            .unwrap(),
        1
    );
    row_id
}

fn reservation(f: &Fixture, row_id: RowId) -> Reservation {
    Reservation {
        id: Uuid::now_v7(),
        campaign_id: f.campaign_id,
        step_id: f.steps[0],
        row_id,
        recipient_email: "ada@example.com".into(),
        mailbox: f.mailbox,
        rfc_message_id: Some(format!("<{}@example.com>", Uuid::now_v7())),
        subject: "Hello".into(),
    }
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn enrollment_mails_each_address_once_and_skips_suppressed(pool: PgPool) {
    let f = fixture(&pool).await;
    sqlx::query("INSERT INTO campaign_suppressions (team_id, email, reason) VALUES ($1, 'gone@example.com', 'unsubscribed')")
        .bind(f.team_id)
        .execute(&pool)
        .await
        .unwrap();
    let due = Utc::now();
    let rows = [
        row(&pool, f.table_id, "a0").await,
        row(&pool, f.table_id, "a1").await,
        row(&pool, f.table_id, "a2").await,
    ];
    let batch = [
        enrollment(rows[0], "ada@example.com", due),
        enrollment(rows[1], " ADA@Example.com ", due),
        enrollment(rows[2], "gone@example.com", due),
    ];
    assert_eq!(f.repo.enroll(f.campaign_id, f.team_id, &batch).await.unwrap(), 1);
    assert_eq!(f.repo.enroll(f.campaign_id, f.team_id, &batch).await.unwrap(), 0);
    let recipients = f.repo.recipients(f.campaign_id, None, 10).await.unwrap();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients[0].email, "ada@example.com");
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn claiming_leases_due_recipients_of_active_campaigns_only(pool: PgPool) {
    let f = fixture(&pool).await;
    let row_id = enrolled(&pool, &f).await;
    let now = Utc::now();
    let lease = now + Duration::minutes(10);
    let claimed = f.repo.claim_due(now, lease, 10).await.unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].row_id, row_id);
    assert_eq!(claimed[0].position, 1);
    assert!(claimed[0].first.is_none());
    // Leased: a second worker gets nothing until the lease expires.
    assert!(f.repo.claim_due(now, lease, 10).await.unwrap().is_empty());
    let after_lease = lease + Duration::minutes(1);
    assert!(
        f.repo
            .transition(f.campaign_id, &[CampaignStatus::Active], CampaignStatus::Paused, None)
            .await
            .unwrap()
    );
    assert!(f.repo.claim_due(after_lease, after_lease, 10).await.unwrap().is_empty());
    f.repo
        .transition(f.campaign_id, &[CampaignStatus::Paused], CampaignStatus::Active, None)
        .await
        .unwrap();
    assert_eq!(f.repo.claim_due(after_lease, after_lease, 10).await.unwrap().len(), 1);
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn a_step_is_reserved_once_per_address(pool: PgPool) {
    let f = fixture(&pool).await;
    let row_id = enrolled(&pool, &f).await;
    let first = reservation(&f, row_id);
    let reserved = f.repo.reserve(&first).await.unwrap();
    assert!(reserved.inserted);
    let again = f.repo.reserve(&reservation(&f, row_id)).await.unwrap();
    assert!(!again.inserted);
    assert_eq!(again.id, first.id);
    assert_eq!(again.status, SendStatus::Reserved);
    assert_eq!(again.rfc_message_id, first.rfc_message_id);
    f.repo
        .finalize(
            Some((
                first.id,
                SendRecord::Sent {
                    email_message_id: None,
                    rfc_message_id: None,
                },
            )),
            f.campaign_id,
            row_id,
            1,
            RecipientUpdate::Advance {
                position: 2,
                at: Some(Utc::now() + Duration::days(1)),
            },
        )
        .await
        .unwrap();
    let sent = f.repo.reserve(&reservation(&f, row_id)).await.unwrap();
    assert!(!sent.inserted);
    assert_eq!(sent.status, SendStatus::Sent);
    // Follow-ups thread under the first send.
    sqlx::query("UPDATE campaign_recipients SET next_send_at = now() - interval '1 minute' WHERE campaign_id = $1")
        .bind(f.campaign_id)
        .execute(&pool)
        .await
        .unwrap();
    let now = Utc::now();
    let due = f.repo.claim_due(now, now + Duration::minutes(10), 10).await.unwrap();
    assert_eq!(due[0].position, 2);
    let thread = due[0].first.as_ref().expect("first send");
    assert_eq!(thread.rfc_message_id, first.rfc_message_id);
    assert_eq!(thread.mailbox, Some(f.mailbox));
    assert_eq!(thread.subject.as_deref(), Some("Hello"));
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn a_sent_step_cannot_be_removed(pool: PgPool) {
    let f = fixture(&pool).await;
    let row_id = enrolled(&pool, &f).await;
    f.repo.reserve(&reservation(&f, row_id)).await.unwrap();
    let keep_second = StepInput {
        id: Some(f.steps[1]),
        ..step("")
    };
    assert_eq!(
        f.repo.replace_steps(f.campaign_id, &[keep_second]).await.unwrap(),
        StepsOutcome::SentStepRemoved
    );
    assert_eq!(f.repo.steps(f.campaign_id).await.unwrap().len(), 2);
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn retries_fail_the_recipient_after_the_attempt_limit(pool: PgPool) {
    let f = fixture(&pool).await;
    let row_id = enrolled(&pool, &f).await;
    let at = Utc::now() + Duration::minutes(5);
    for attempt in 1..MAX_SEND_ATTEMPTS {
        f.repo
            .finalize(None, f.campaign_id, row_id, 1, RecipientUpdate::Retry { at })
            .await
            .unwrap();
        let (state, next, attempts) = state(&pool, f.campaign_id, row_id).await;
        assert_eq!((state.as_str(), attempts), ("active", attempt as i16));
        assert!(next.is_some());
    }
    f.repo
        .finalize(None, f.campaign_id, row_id, 1, RecipientUpdate::Retry { at })
        .await
        .unwrap();
    let (state, next, _) = state(&pool, f.campaign_id, row_id).await;
    assert_eq!(state, "failed");
    assert!(next.is_none());
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn a_stale_claim_keeps_a_reply(pool: PgPool) {
    let f = fixture(&pool).await;
    let row_id = enrolled(&pool, &f).await;
    sqlx::query("UPDATE campaign_recipients SET state = 'replied', next_send_at = NULL WHERE campaign_id = $1")
        .bind(f.campaign_id)
        .execute(&pool)
        .await
        .unwrap();
    f.repo
        .finalize(
            None,
            f.campaign_id,
            row_id,
            1,
            RecipientUpdate::Advance {
                position: 2,
                at: Some(Utc::now()),
            },
        )
        .await
        .unwrap();
    let (state, next, _) = state(&pool, f.campaign_id, row_id).await;
    assert_eq!(state, "replied");
    assert!(next.is_none());
}

#[sqlx::test(migrator = "MACRO_DB_MIGRATIONS")]
async fn the_campaign_completes_when_nobody_is_left(pool: PgPool) {
    let f = fixture(&pool).await;
    assert!(!f.repo.complete_if_done(f.campaign_id).await.unwrap());
    let row_id = enrolled(&pool, &f).await;
    assert!(!f.repo.complete_if_done(f.campaign_id).await.unwrap());
    f.repo
        .finalize(
            None,
            f.campaign_id,
            row_id,
            1,
            RecipientUpdate::Advance { position: 3, at: None },
        )
        .await
        .unwrap();
    assert_eq!(state(&pool, f.campaign_id, row_id).await.0, "completed");
    assert!(f.repo.complete_if_done(f.campaign_id).await.unwrap());
    let campaign = f.repo.get_many(&[f.campaign_id]).await.unwrap();
    assert_eq!(campaign[0].status, CampaignStatus::Completed);
}
