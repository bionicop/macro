//! What counts as activity in the campaign domain. Lifecycle events map
//! through `Activity::attributed` with a `CommonAction` on the campaign;
//! launching is the campaign's own action, "sent". Changes with no
//! attribution (internal callers) belong on nobody's feed.

#[cfg(test)]
mod test;

use ::activity::{
    Action, Activity, ActivitySource, Attribution, CommonAction, DomainActivity, EntityType,
    Ingest, event_time,
};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use super::events::{self, CampaignTopicEvent};

/// A campaign started or resumed sending: an action only campaigns have.
pub struct CampaignLaunched {
    campaign_id: String,
}

impl CampaignLaunched {
    /// The launch of `campaign_id`.
    pub fn new(campaign_id: Uuid) -> Self {
        Self {
            campaign_id: campaign_id.to_string(),
        }
    }
}

impl DomainActivity for CampaignLaunched {
    const ENTITY_TYPE: EntityType = EntityType::Campaign;

    fn entity_id(&self) -> &str {
        &self.campaign_id
    }

    fn into_action(self) -> Action {
        Action::Sent
    }
}

impl ActivitySource for CampaignTopicEvent {
    /// Maps one `macro.campaigns` event to its ingest outcome. Exhaustive on
    /// purpose: a new event variant fails compilation here until someone
    /// classifies it.
    fn ingest(&self, event_id: Uuid) -> Ingest {
        let single = |attribution: Attribution,
                      action: CommonAction,
                      campaign_id: Uuid,
                      occurred_at: DateTime<Utc>| {
            Ingest::Insert(vec![Activity::attributed(
                event_id,
                0,
                attribution,
                EntityType::Campaign,
                campaign_id.to_string(),
                action,
                occurred_at,
            )])
        };
        let attributed = |attribution: &Option<events::Attribution>,
                          action: CommonAction,
                          campaign_id: Uuid| match attribution {
            Some(attribution) => single(
                Attribution::new(attribution.actor.clone(), attribution.on_behalf_of.clone()),
                action,
                campaign_id,
                event_time(event_id),
            ),
            None => Ingest::Ignore,
        };

        match self {
            Self::Created(metadata) => single(
                Attribution::new(
                    metadata.attribution.actor.clone(),
                    metadata.attribution.on_behalf_of.clone(),
                ),
                CommonAction::Created,
                metadata.campaign_id,
                metadata.created_at,
            ),
            Self::Renamed(metadata) => attributed(
                &metadata.attribution,
                CommonAction::Edited,
                metadata.campaign_id,
            ),
            Self::Trashed(metadata) => attributed(
                &metadata.attribution,
                CommonAction::Deleted,
                metadata.campaign_id,
            ),
            // Coming back from the trash, or pausing, is a change to the
            // campaign, not a second creation.
            Self::Restored(metadata) | Self::Paused(metadata) => attributed(
                &metadata.attribution,
                CommonAction::Edited,
                metadata.campaign_id,
            ),
            Self::Launched(metadata) => match &metadata.attribution {
                Some(attribution) => Ingest::Insert(vec![Activity::from_domain(
                    event_id,
                    0,
                    attribution.actor.clone(),
                    attribution.on_behalf_of.clone(),
                    CampaignLaunched::new(metadata.campaign_id),
                    event_time(event_id),
                )]),
                None => Ingest::Ignore,
            },
        }
    }
}
