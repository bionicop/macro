//! Campaign use cases: CRM-pipeline-style policy over reusable database
//! storage, plus the sequence, senders and launch.

use super::models::{
    AccessibleCampaign, Campaign, CampaignBlueprint, CampaignError, CampaignSettings,
    CampaignSharing, CampaignStats, CampaignStatus, CreateCampaign, Enrollment, LaunchCampaign,
    LaunchOutcome, Recipients, Sender, SendersOutcome, Step, StepInput, StepsOutcome,
};
use super::ports::{CampaignRepo, ContactDirectory};
use super::schedule::{SendWindow, parse_zone};
use super::template;
use bot_id::BotId;
use chrono::{Duration, Utc};
use databases::domain::{
    models::{
        AppliedOps, CardPosition, ColumnId, ColumnProtection, DatabaseId, OpBatch, RowId,
        TableDetail, TableId, ViewId, Viewer,
    },
    provisioning::{ProvisionedColumn, StorageBlueprint},
    storage::{DatabaseStorageService, StorageRow, StorageRows, StorageRowsQuery},
};
use entity_access::domain::{
    models::{
        AccessLevel, EditAccessLevel, EntityAccessAuth, EntityAccessReceipt, EntityPermission,
        EntityType, MemberTeamRole, OwnerAccessLevel, RequiredPermission, ViewAccessLevel,
    },
    ports::{AccessibleCampaigns, EntityAccessService},
};
use macro_user_id::user_id::MacroUserIdStr;
use models_permissions::share_permission::{
    SharePermissionV2, UpdateSharePermissionRequestV2,
    channel_share_permission::{
        ChannelSharePermission, UpdateChannelSharePermission, UpdateOperation,
    },
};
use models_properties::service::property_value::PropertyValue;
use models_properties::{DataType, EntityType as PropertyEntityType};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use uuid::Uuid;

/// Most steps in a sequence.
const MAX_STEPS: usize = 20;
/// Most mailboxes in a rotation.
const MAX_SENDERS: usize = 20;
/// Most channel grants one request may change.
const MAX_CHANNEL_GRANTS_PER_UPDATE: usize = 100;
/// Recipients per page.
const RECIPIENT_PAGE: u32 = 100;

/// Campaign use cases for HTTP, agents and other driving adapters.
pub trait CampaignService: Send + Sync + 'static {
    /// Create a draft for the authenticated team member.
    fn create(
        &self,
        team: EntityAccessReceipt<MemberTeamRole>,
        input: CreateCampaign,
    ) -> impl Future<Output = Result<AccessibleCampaign, CampaignError>> + Send;
    /// Visible, live campaigns of this team.
    fn list(
        &self,
        team: EntityAccessReceipt<MemberTeamRole>,
    ) -> impl Future<Output = Result<Vec<AccessibleCampaign>, CampaignError>> + Send;
    /// Read a campaign by identity.
    fn get(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> impl Future<Output = Result<AccessibleCampaign, CampaignError>> + Send;
    /// The recipient table's schema.
    fn table(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> impl Future<Output = Result<TableDetail, CampaignError>> + Send;
    /// Query recipient rows with the shared database filter and sort semantics.
    fn query_rows(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        query: StorageRowsQuery,
    ) -> impl Future<Output = Result<StorageRows, CampaignError>> + Send;
    /// The cells of those of `rows` that are this campaign's, in row order.
    fn read_rows(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        rows: &[RowId],
    ) -> impl Future<Output = Result<Vec<StorageRow>, CampaignError>> + Send;
    /// A saved board's order.
    fn view_positions(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        view: ViewId,
    ) -> impl Future<Output = Result<Vec<CardPosition>, CampaignError>> + Send;
    /// Edit the recipient table with the shared storage operation planner.
    /// `acting_bot` is the agent making the change, for attribution only.
    fn apply_ops(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        acting_bot: Option<BotId>,
        batch: OpBatch,
    ) -> impl Future<Output = Result<AppliedOps, CampaignError>> + Send;
    /// Rename.
    fn rename(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        name: String,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
    /// Change team sharing.
    fn share(
        &self,
        receipt: EntityAccessReceipt<OwnerAccessLevel>,
        sharing: CampaignSharing,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
    /// Owner, team grant and channel recipients.
    fn share_permissions(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
    ) -> impl Future<Output = Result<SharePermissionV2, CampaignError>> + Send;
    /// Change channel recipients; team access changes through [`Self::share`].
    fn update_share_permissions(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        request: UpdateSharePermissionRequestV2,
    ) -> impl Future<Output = Result<SharePermissionV2, CampaignError>> + Send;
    /// Move to trash or restore. Trashed campaigns send nothing.
    fn set_trashed(
        &self,
        receipt: EntityAccessReceipt<OwnerAccessLevel>,
        trashed: bool,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
    /// Replace the window, days and tracking.
    fn update_settings(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        settings: CampaignSettings,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
    /// The sequence in order.
    fn steps(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> impl Future<Output = Result<Vec<Step>, CampaignError>> + Send;
    /// Replace the sequence. Sent steps cannot be removed.
    fn set_steps(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        steps: Vec<StepInput>,
    ) -> impl Future<Output = Result<Vec<Step>, CampaignError>> + Send;
    /// The sender rotation.
    fn senders(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> impl Future<Output = Result<Vec<Sender>, CampaignError>> + Send;
    /// Replace the rotation with the caller's own mailboxes.
    fn set_senders(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        senders: Vec<Sender>,
    ) -> impl Future<Output = Result<Vec<Sender>, CampaignError>> + Send;
    /// Enroll the table's contacts and start, or resume, sending. An agent
    /// must quote the user's approval.
    fn launch(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        acting_bot: Option<BotId>,
        input: LaunchCampaign,
    ) -> impl Future<Output = Result<LaunchOutcome, CampaignError>> + Send;
    /// Stop sending; enrolled recipients keep their place.
    fn pause(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
    ) -> impl Future<Output = Result<(), CampaignError>> + Send;
    /// A page of enrolled recipients.
    fn recipients(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        after: Option<RowId>,
    ) -> impl Future<Output = Result<Recipients, CampaignError>> + Send;
    /// Stop these recipients' sequences; their rows stay.
    fn remove_recipients(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        rows: Vec<RowId>,
    ) -> impl Future<Output = Result<u64, CampaignError>> + Send;
    /// Recipient and send counts.
    fn stats(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> impl Future<Output = Result<CampaignStats, CampaignError>> + Send;
}

/// Campaign policy, composed with the database, access and CRM services.
pub struct CampaignServiceImpl<Repo, Databases, Access, Contacts> {
    pub(super) repo: Repo,
    pub(super) databases: Arc<Databases>,
    access: Arc<Access>,
    contacts: Contacts,
}

pub(super) fn storage(error: impl std::error::Error + Send + Sync + 'static) -> CampaignError {
    CampaignError::Storage(rootcause::Report::new(error).into_dynamic())
}

fn actor<T: RequiredPermission>(
    receipt: &EntityAccessReceipt<T>,
) -> Result<MacroUserIdStr<'static>, CampaignError> {
    match receipt.auth() {
        EntityAccessAuth::Authenticated(user) => Ok(user.clone()),
        _ => Err(CampaignError::Invalid("An authenticated user is required")),
    }
}

fn team_id(receipt: &EntityAccessReceipt<MemberTeamRole>) -> Result<Uuid, CampaignError> {
    if receipt.entity().entity_type != EntityType::Team {
        return Err(CampaignError::Invalid("Choose a team"));
    }
    receipt
        .entity()
        .entity_id
        .parse()
        .map_err(|_| CampaignError::Invalid("Choose a team"))
}

fn grant<T: RequiredPermission>(receipt: &EntityAccessReceipt<T>) -> AccessLevel {
    match receipt.entity_permission() {
        EntityPermission::AccessLevel { access_level } => *access_level,
        _ => AccessLevel::View,
    }
}

fn name(input: &str) -> Result<String, CampaignError> {
    let input = input.trim();
    if input.is_empty() || input.chars().count() > 200 {
        return Err(CampaignError::Invalid(
            "Use a campaign name between 1 and 200 characters",
        ));
    }
    Ok(input.to_string())
}

/// The recipient table a new campaign starts with: the protected contact
/// reference and an optional per-recipient time zone.
fn blueprint(
    team_id: Uuid,
    creator: MacroUserIdStr<'static>,
    name: String,
    sharing: CampaignSharing,
) -> CampaignBlueprint {
    let primary_column_id = ColumnId::new();
    let time_zone_column_id = ColumnId::new();
    CampaignBlueprint {
        id: macro_uuid::generate_uuid_v7(),
        team_id,
        sharing,
        name,
        creator,
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
    }
}

fn validate_steps(steps: &[StepInput]) -> Result<(), CampaignError> {
    if steps.len() > MAX_STEPS {
        return Err(CampaignError::Invalid("Use at most 20 steps"));
    }
    let mut ids = BTreeSet::new();
    for step in steps {
        if step.id.is_some_and(|id| !ids.insert(id)) {
            return Err(CampaignError::Invalid("Give each step once"));
        }
        if step.subject.chars().count() > 500 || step.body_html.len() > 512 * 1024 {
            return Err(CampaignError::Invalid(
                "Keep subjects under 500 characters and bodies under 512 KB",
            ));
        }
        if step.delay_minutes > 365 * 24 * 60 {
            return Err(CampaignError::Invalid("Wait at most a year between steps"));
        }
    }
    Ok(())
}

fn validate_senders(senders: &[Sender]) -> Result<(), CampaignError> {
    if senders.len() > MAX_SENDERS {
        return Err(CampaignError::Invalid("Use at most 20 mailboxes"));
    }
    let mut mailboxes = BTreeSet::new();
    for sender in senders {
        if !(1..=2000).contains(&sender.daily_cap) {
            return Err(CampaignError::Invalid(
                "Send between 1 and 2000 emails a day per mailbox",
            ));
        }
        if !mailboxes.insert(format!("{:?}", sender.mailbox)) {
            return Err(CampaignError::Invalid("Add each mailbox once"));
        }
    }
    Ok(())
}

/// The channel grants of a sharing request. Campaigns have no share link,
/// and team access changes only through [`CampaignService::share`].
fn requested_channel_grants(
    request: UpdateSharePermissionRequestV2,
) -> Result<Vec<UpdateChannelSharePermission>, CampaignError> {
    if request.link_share.is_some()
        || request.link_share_access_level.is_some()
        || request.team_share_access_level.is_some()
    {
        return Err(CampaignError::Invalid(
            "Share a campaign with people and channels; only its owner changes team access",
        ));
    }
    let grants = request.channel_share_permissions.unwrap_or_default();
    if grants.len() > MAX_CHANNEL_GRANTS_PER_UPDATE {
        return Err(CampaignError::Invalid(
            "Share with at most 100 channels at a time",
        ));
    }
    let mut channels = std::collections::HashSet::new();
    for grant in &grants {
        if !channels.insert(&grant.channel_id)
            || Uuid::parse_str(&grant.channel_id).is_err()
            || grant.access_level == Some(AccessLevel::Owner)
            || (grant.operation != UpdateOperation::Remove && grant.access_level.is_none())
        {
            return Err(CampaignError::Invalid(
                "Give each channel once, with view, comment or edit access",
            ));
        }
    }
    Ok(grants)
}

fn share_permission(campaign: &Campaign, channels: Vec<ChannelSharePermission>) -> SharePermissionV2 {
    SharePermissionV2 {
        id: campaign.id.to_string(),
        owner: campaign.user_id.clone(),
        link_share: None,
        link_share_access_level: None,
        team_share_access_level: (campaign.sharing == CampaignSharing::Team)
            .then_some(AccessLevel::Edit),
        channel_share_permissions: Some(channels),
    }
}

/// Distinct contacts explicitly written to the contact column by this batch.
fn contact_references(
    campaign: &Campaign,
    batch: &OpBatch,
) -> Result<BTreeSet<Uuid>, CampaignError> {
    use models_databases::{CellValue, CellWrite, DatabaseOp, RowChanges, RowsChange};
    let mut references = BTreeSet::new();
    for op in &batch.ops {
        let cells: Vec<&CellWrite> = match op {
            DatabaseOp::Rows {
                change: RowsChange::Insert { rows },
                ..
            } => rows.iter().flatten().collect(),
            DatabaseOp::Rows {
                change:
                    RowsChange::Update {
                        changes: RowChanges::Uniform { cells, .. },
                    },
                ..
            } => cells.iter().collect(),
            DatabaseOp::Rows {
                change:
                    RowsChange::Update {
                        changes: RowChanges::PerRow { rows },
                    },
                ..
            } => rows.iter().flat_map(|row| &row.cells).collect(),
            _ => continue,
        };
        for cell in cells {
            if cell.column != campaign.primary_column_id {
                continue;
            }
            if let CellValue::Entities(values) = &cell.value {
                for value in values {
                    if value.entity_type != models_databases::EntityKind::Contact {
                        return Err(CampaignError::Invalid("Choose a CRM contact"));
                    }
                    references.insert(
                        value
                            .entity_id
                            .parse()
                            .map_err(|_| CampaignError::Invalid("Choose a valid CRM contact"))?,
                    );
                }
            }
        }
    }
    Ok(references)
}

/// The contact a row references, if any.
fn row_contact(row: &StorageRow, column: ColumnId) -> Option<Uuid> {
    match row.cells.get(&column)? {
        PropertyValue::EntityRef(values) => values
            .iter()
            .find(|value| value.entity_type == PropertyEntityType::Contact)?
            .entity_id
            .parse()
            .ok(),
        _ => None,
    }
}

/// The row's time zone, if it names a valid one.
fn row_zone(row: &StorageRow, column: Option<ColumnId>) -> Option<String> {
    match row.cells.get(&column?)? {
        PropertyValue::Str(zone) => parse_zone(zone).map(|zone| zone.name().to_string()),
        _ => None,
    }
}

impl<R: CampaignRepo, D, A, C> CampaignServiceImpl<R, D, A, C> {
    /// Compose the service from domain capabilities.
    pub fn new(repo: R, databases: Arc<D>, access: Arc<A>, contacts: C) -> Self {
        Self {
            repo,
            databases,
            access,
            contacts,
        }
    }

    async fn campaign<T: RequiredPermission>(
        &self,
        receipt: &EntityAccessReceipt<T>,
    ) -> Result<Campaign, CampaignError> {
        if receipt.entity().entity_type != EntityType::Campaign {
            return Err(CampaignError::NotFound);
        }
        let id = receipt
            .entity()
            .entity_id
            .parse()
            .map_err(|_| CampaignError::NotFound)?;
        self.repo
            .get_many(&[id])
            .await
            .map_err(storage)?
            .pop()
            .ok_or(CampaignError::NotFound)
    }

    async fn live<T: RequiredPermission>(
        &self,
        receipt: &EntityAccessReceipt<T>,
    ) -> Result<Campaign, CampaignError> {
        let campaign = self.campaign(receipt).await?;
        if campaign.trashed_at.is_some() {
            return Err(CampaignError::NotFound);
        }
        Ok(campaign)
    }

    async fn guard(&self, id: Uuid) -> Result<R::Guard, CampaignError> {
        self.repo
            .lock_live(id)
            .await
            .map_err(storage)?
            .ok_or(CampaignError::NotFound)
    }

    async fn write_guard(&self, id: Uuid) -> Result<R::Guard, CampaignError> {
        self.repo
            .lock_write(id)
            .await
            .map_err(storage)?
            .ok_or(CampaignError::NotFound)
    }
}

impl<R, D, A, C> CampaignServiceImpl<R, D, A, C>
where
    R: CampaignRepo,
    D: DatabaseStorageService,
    A: EntityAccessService + AccessibleCampaigns,
    C: ContactDirectory,
{
    pub(super) async fn recipient_table(&self, campaign: &Campaign) -> Result<TableDetail, CampaignError> {
        self.databases
            .storage_tables(campaign.database_id)
            .await?
            .into_iter()
            .find(|table| table.table.id == campaign.table_id)
            .ok_or(CampaignError::NotFound)
    }

    /// Enroll every row with a reachable contact that is not enrolled yet.
    /// The first step is due after its delay, inside the recipient's window.
    /// Also run by the sender for rows added while the campaign is active.
    pub async fn enroll_rows(
        &self,
        campaign: &Campaign,
        first_delay_minutes: u32,
    ) -> Result<LaunchOutcome, CampaignError> {
        let window = SendWindow::from_settings(&campaign.settings)?;
        let earliest = Utc::now() + Duration::minutes(first_delay_minutes.into());
        let mut outcome = LaunchOutcome {
            enrolled: 0,
            skipped: 0,
        };
        let mut after = None;
        loop {
            let page = self
                .databases
                .storage_rows(
                    campaign.database_id,
                    campaign.table_id,
                    StorageRowsQuery {
                        after,
                        ..Default::default()
                    },
                )
                .await?;
            let contacts: Vec<Uuid> = page
                .rows
                .iter()
                .filter_map(|row| row_contact(row, campaign.primary_column_id))
                .collect();
            let addresses = self
                .contacts
                .contact_addresses(campaign.team_id, &contacts)
                .await
                .map_err(storage)?;
            let mut enrollments = Vec::with_capacity(page.rows.len());
            for row in &page.rows {
                let Some((contact_id, address)) = row_contact(row, campaign.primary_column_id)
                    .and_then(|id| Some((id, addresses.get(&id)?)))
                else {
                    outcome.skipped += 1;
                    continue;
                };
                let time_zone = row_zone(row, campaign.settings.time_zone_column_id);
                let window = match time_zone.as_deref().and_then(parse_zone) {
                    Some(zone) => window.in_zone(zone),
                    None => window,
                };
                enrollments.push(Enrollment {
                    row_id: row.row_id,
                    contact_id,
                    email: address.email.clone(),
                    name: address.name.clone(),
                    time_zone,
                    next_send_at: window.next_open(earliest),
                });
            }
            let inserted = self
                .repo
                .enroll(campaign.id, campaign.team_id, &enrollments)
                .await
                .map_err(storage)?;
            outcome.enrolled += inserted;
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        Ok(outcome)
    }
}

impl<R, D, A, C> CampaignService for CampaignServiceImpl<R, D, A, C>
where
    R: CampaignRepo,
    D: DatabaseStorageService,
    A: EntityAccessService + AccessibleCampaigns,
    C: ContactDirectory,
{
    async fn create(
        &self,
        team: EntityAccessReceipt<MemberTeamRole>,
        input: CreateCampaign,
    ) -> Result<AccessibleCampaign, CampaignError> {
        let name = name(&input.name)?;
        let creator = actor(&team)?;
        let blueprint = blueprint(team_id(&team)?, creator, name, input.sharing);
        let id = blueprint.id;
        self.repo.create(&blueprint).await.map_err(storage)?;
        let campaign = self
            .repo
            .get_many(&[id])
            .await
            .map_err(storage)?
            .pop()
            .ok_or(CampaignError::NotFound)?;
        Ok(AccessibleCampaign {
            campaign,
            grant: AccessLevel::Owner,
        })
    }

    async fn list(
        &self,
        team: EntityAccessReceipt<MemberTeamRole>,
    ) -> Result<Vec<AccessibleCampaign>, CampaignError> {
        let user = actor(&team)?;
        let team_id = team_id(&team)?;
        let grants: HashMap<_, _> = self
            .access
            .accessible_campaigns(&user)
            .await?
            .into_iter()
            .collect();
        let ids = grants.keys().copied().collect::<Vec<_>>();
        Ok(self
            .repo
            .get_many(&ids)
            .await
            .map_err(storage)?
            .into_iter()
            .filter(|c| c.team_id == team_id && c.trashed_at.is_none())
            .map(|campaign| AccessibleCampaign {
                grant: grants[&campaign.id],
                campaign,
            })
            .collect())
    }

    async fn get(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> Result<AccessibleCampaign, CampaignError> {
        let campaign = self.live(&receipt).await?;
        Ok(AccessibleCampaign {
            campaign,
            grant: grant(&receipt),
        })
    }

    async fn table(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> Result<TableDetail, CampaignError> {
        let campaign = self.campaign(&receipt).await?;
        let _guard = self.guard(campaign.id).await?;
        let mut table = self.recipient_table(&campaign).await?;
        let editable = matches!(grant(&receipt), AccessLevel::Edit | AccessLevel::Owner);
        for column in &mut table.columns {
            column.writable &= editable;
        }
        Ok(table)
    }

    async fn query_rows(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        query: StorageRowsQuery,
    ) -> Result<StorageRows, CampaignError> {
        let campaign = self.campaign(&receipt).await?;
        let _guard = self.guard(campaign.id).await?;
        Ok(self
            .databases
            .storage_rows(campaign.database_id, campaign.table_id, query)
            .await?)
    }

    async fn read_rows(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        rows: &[RowId],
    ) -> Result<Vec<StorageRow>, CampaignError> {
        let campaign = self.campaign(&receipt).await?;
        let _guard = self.guard(campaign.id).await?;
        Ok(self
            .databases
            .storage_row_cells(campaign.database_id, campaign.table_id, rows)
            .await?)
    }

    async fn view_positions(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        view: ViewId,
    ) -> Result<Vec<CardPosition>, CampaignError> {
        let campaign = self.campaign(&receipt).await?;
        let _guard = self.guard(campaign.id).await?;
        Ok(self
            .databases
            .storage_view_positions(campaign.database_id, campaign.table_id, view)
            .await?)
    }

    async fn apply_ops(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        acting_bot: Option<BotId>,
        batch: OpBatch,
    ) -> Result<AppliedOps, CampaignError> {
        use models_databases::{DatabaseOp, TableChange};
        let campaign = self.campaign(&receipt).await?;
        for op in &batch.ops {
            let table = match op {
                DatabaseOp::Rows { table, .. }
                | DatabaseOp::View { table, .. }
                | DatabaseOp::Column { table, .. }
                | DatabaseOp::Table {
                    table,
                    change: TableChange::ReorderColumns { .. },
                } => *table,
                _ => {
                    return Err(CampaignError::Invalid(
                        "A campaign has one recipient table; customize its columns and rows",
                    ));
                }
            };
            if table != campaign.table_id {
                return Err(CampaignError::NotFound);
            }
        }
        let viewer = Viewer {
            user_id: actor(&receipt)?,
            acting_bot,
        };
        // A campaign grant does not grant access to the contacts it mails.
        for id in contact_references(&campaign, &batch)? {
            self.access
                .generate_entity_access_receipt::<ViewAccessLevel>(
                    &viewer.user_id,
                    None,
                    &id.to_string(),
                    EntityType::CrmContact,
                )
                .await?;
        }
        let _guard = self.write_guard(campaign.id).await?;
        Ok(self
            .databases
            .apply_storage_ops(campaign.database_id, viewer, batch)
            .await?)
    }

    async fn rename(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        input: String,
    ) -> Result<(), CampaignError> {
        let name = name(&input)?;
        let campaign = self.live(&receipt).await?;
        self.repo.rename(campaign.id, &name).await.map_err(storage)
    }

    async fn share(
        &self,
        receipt: EntityAccessReceipt<OwnerAccessLevel>,
        sharing: CampaignSharing,
    ) -> Result<(), CampaignError> {
        let campaign = self.live(&receipt).await?;
        self.repo.share(&campaign, sharing).await.map_err(storage)
    }

    async fn share_permissions(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
    ) -> Result<SharePermissionV2, CampaignError> {
        let campaign = self.live(&receipt).await?;
        let channels = self
            .repo
            .channel_grants(campaign.id)
            .await
            .map_err(storage)?;
        Ok(share_permission(&campaign, channels))
    }

    async fn update_share_permissions(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        request: UpdateSharePermissionRequestV2,
    ) -> Result<SharePermissionV2, CampaignError> {
        let grants = requested_channel_grants(request)?;
        let campaign = self.live(&receipt).await?;
        if !self
            .repo
            .update_channel_grants(campaign.id, &grants)
            .await
            .map_err(storage)?
        {
            return Err(CampaignError::NotFound);
        }
        self.share_permissions(receipt).await
    }

    async fn set_trashed(
        &self,
        receipt: EntityAccessReceipt<OwnerAccessLevel>,
        trashed: bool,
    ) -> Result<(), CampaignError> {
        let campaign = self.campaign(&receipt).await?;
        self.repo
            .set_trashed(campaign.id, trashed)
            .await
            .map_err(storage)
    }

    async fn update_settings(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        mut settings: CampaignSettings,
    ) -> Result<(), CampaignError> {
        SendWindow::from_settings(&settings)?;
        // Store the canonical zone name.
        settings.time_zone = parse_zone(&settings.time_zone)
            .map(|zone| zone.name().to_string())
            .unwrap_or(settings.time_zone);
        let campaign = self.live(&receipt).await?;
        if let Some(column) = settings.time_zone_column_id {
            let table = self.recipient_table(&campaign).await?;
            let found = table
                .columns
                .iter()
                .find(|detail| detail.column.id == column)
                .ok_or(CampaignError::Invalid("Choose a column of the recipient table"))?;
            if found.definition.definition.data_type != DataType::String {
                return Err(CampaignError::Invalid("Choose a text column for time zones"));
            }
        }
        self.repo
            .update_settings(campaign.id, &settings)
            .await
            .map_err(storage)
    }

    async fn steps(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> Result<Vec<Step>, CampaignError> {
        let campaign = self.live(&receipt).await?;
        self.repo.steps(campaign.id).await.map_err(storage)
    }

    async fn set_steps(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        steps: Vec<StepInput>,
    ) -> Result<Vec<Step>, CampaignError> {
        validate_steps(&steps)?;
        let campaign = self.live(&receipt).await?;
        match self
            .repo
            .replace_steps(campaign.id, &steps)
            .await
            .map_err(storage)?
        {
            StepsOutcome::Replaced => self.repo.steps(campaign.id).await.map_err(storage),
            StepsOutcome::SentStepRemoved => Err(CampaignError::Conflict(
                "A step that has been sent can be edited but not removed",
            )),
            StepsOutcome::UnknownStep => Err(CampaignError::Invalid("Keep this campaign's own steps")),
            StepsOutcome::NotLive => Err(CampaignError::NotFound),
        }
    }

    async fn senders(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> Result<Vec<Sender>, CampaignError> {
        let campaign = self.live(&receipt).await?;
        self.repo.senders(campaign.id).await.map_err(storage)
    }

    async fn set_senders(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        senders: Vec<Sender>,
    ) -> Result<Vec<Sender>, CampaignError> {
        validate_senders(&senders)?;
        let user = actor(&receipt)?;
        let campaign = self.live(&receipt).await?;
        match self
            .repo
            .replace_senders(campaign.id, &user, &senders)
            .await
            .map_err(storage)?
        {
            SendersOutcome::Replaced => self.repo.senders(campaign.id).await.map_err(storage),
            SendersOutcome::NotOwned => Err(CampaignError::Invalid(
                "Send only from your own connected mailboxes",
            )),
            SendersOutcome::NotLive => Err(CampaignError::NotFound),
        }
    }

    #[tracing::instrument(skip_all, fields(campaign_id = %receipt.entity().entity_id, agent = acting_bot.is_some()), err)]
    async fn launch(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        acting_bot: Option<BotId>,
        input: LaunchCampaign,
    ) -> Result<LaunchOutcome, CampaignError> {
        let confirmation = input
            .user_confirmation
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if acting_bot.is_some() && confirmation.is_none() {
            return Err(CampaignError::Invalid(
                "Quote the user's own words approving this launch",
            ));
        }
        if confirmation.is_some_and(|text| text.chars().count() > 2000) {
            return Err(CampaignError::Invalid("Quote at most 2000 characters"));
        }
        let campaign = self.live(&receipt).await?;
        if campaign.status == CampaignStatus::Active {
            return Err(CampaignError::Conflict("The campaign is already sending"));
        }
        let steps = self.repo.steps(campaign.id).await.map_err(storage)?;
        let Some(first) = steps.first() else {
            return Err(CampaignError::Invalid("Write at least one email"));
        };
        if first.subject.trim().is_empty() {
            return Err(CampaignError::Invalid("Give the first email a subject"));
        }
        if steps.iter().any(|step| step.body_html.trim().is_empty()) {
            return Err(CampaignError::Invalid("Write a body for every email"));
        }
        if self
            .repo
            .senders(campaign.id)
            .await
            .map_err(storage)?
            .is_empty()
        {
            return Err(CampaignError::Invalid("Choose a mailbox to send from"));
        }
        let table = self.recipient_table(&campaign).await?;
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|column| column.name().to_string())
            .collect();
        template::check_fields(
            steps
                .iter()
                .flat_map(|step| [step.subject.as_str(), step.body_html.as_str()]),
            &columns,
        )?;
        // The status change claims the launch; enrollment is idempotent and
        // the sender enrolls rows added later, so a partial enrollment heals.
        if !self
            .repo
            .transition(
                campaign.id,
                &[
                    CampaignStatus::Draft,
                    CampaignStatus::Paused,
                    CampaignStatus::Completed,
                ],
                CampaignStatus::Active,
                confirmation,
            )
            .await
            .map_err(storage)?
        {
            return Err(CampaignError::Conflict("The campaign is already sending"));
        }
        let _guard = self.guard(campaign.id).await?;
        self.enroll_rows(&campaign, first.delay_minutes).await
    }

    async fn pause(&self, receipt: EntityAccessReceipt<EditAccessLevel>) -> Result<(), CampaignError> {
        let campaign = self.live(&receipt).await?;
        if !self
            .repo
            .transition(
                campaign.id,
                &[CampaignStatus::Active],
                CampaignStatus::Paused,
                None,
            )
            .await
            .map_err(storage)?
        {
            return Err(CampaignError::Conflict("The campaign is not sending"));
        }
        Ok(())
    }

    async fn recipients(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
        after: Option<RowId>,
    ) -> Result<Recipients, CampaignError> {
        let campaign = self.live(&receipt).await?;
        let mut recipients = self
            .repo
            .recipients(campaign.id, after, RECIPIENT_PAGE + 1)
            .await
            .map_err(storage)?;
        let next = (recipients.len() > RECIPIENT_PAGE as usize).then(|| {
            recipients.truncate(RECIPIENT_PAGE as usize);
            recipients.last().map(|r| r.row_id)
        });
        Ok(Recipients {
            recipients,
            next: next.flatten(),
        })
    }

    async fn remove_recipients(
        &self,
        receipt: EntityAccessReceipt<EditAccessLevel>,
        rows: Vec<RowId>,
    ) -> Result<u64, CampaignError> {
        if rows.len() > 1000 {
            return Err(CampaignError::Invalid("Remove at most 1000 recipients at a time"));
        }
        let campaign = self.live(&receipt).await?;
        self.repo
            .remove_recipients(campaign.id, &rows)
            .await
            .map_err(storage)
    }

    async fn stats(
        &self,
        receipt: EntityAccessReceipt<ViewAccessLevel>,
    ) -> Result<CampaignStats, CampaignError> {
        let campaign = self.live(&receipt).await?;
        self.repo.stats(campaign.id).await.map_err(storage)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::domain::models::SenderMailbox;

    fn step(id: Option<Uuid>) -> StepInput {
        StepInput {
            id,
            delay_minutes: 0,
            subject: "Hi".into(),
            body_html: "<p>Hi</p>".into(),
            body_text: None,
            body_macro: None,
        }
    }

    #[test]
    fn steps_are_given_once() {
        let id = Uuid::nil();
        assert!(validate_steps(&[step(Some(id)), step(None), step(None)]).is_ok());
        assert!(validate_steps(&[step(Some(id)), step(Some(id))]).is_err());
        assert!(validate_steps(&vec![step(None); MAX_STEPS + 1]).is_err());
    }

    #[test]
    fn mailboxes_are_added_once_within_caps() {
        let sender = |cap| Sender {
            mailbox: SenderMailbox::Link {
                link_id: Uuid::nil(),
            },
            daily_cap: cap,
        };
        assert!(validate_senders(&[sender(50)]).is_ok());
        assert!(validate_senders(&[sender(50), sender(60)]).is_err());
        assert!(validate_senders(&[sender(0)]).is_err());
        assert!(validate_senders(&[sender(2001)]).is_err());
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(name("  Q4 outreach ").unwrap(), "Q4 outreach");
        assert!(name(" ").is_err());
        assert!(name(&"x".repeat(201)).is_err());
    }
}
