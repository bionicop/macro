//! The durable `macro.campaigns` events other domains consume, activity
//! among them.
//!
//! Only changes a person (or an agent for them) made are published: the
//! sender's own progress (a recipient's step going out, a bounce, a reply)
//! belongs to the campaign's stats, not to anyone's activity feed.

use activity::Actor;
use chrono::{DateTime, Utc};
use macro_event_broker::{Event, MacroEvent, TopicEvent};
use macro_event_topics::MacroCampaignsTopic;
use macro_user_id::user_id::MacroUserIdStr;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Who performed a change: the principal that mechanically acted and, when a
/// bot acted for a user, the user whose feed the action belongs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attribution {
    /// Who mechanically acted.
    pub actor: Actor<'static>,
    /// The user the actor acted for, when different from the actor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_behalf_of: Option<MacroUserIdStr<'static>>,
}

impl Attribution {
    /// A user acting for themselves.
    pub fn user(user: MacroUserIdStr<'static>) -> Self {
        Self {
            actor: Actor::new_from_user(user),
            on_behalf_of: None,
        }
    }

    /// `user` acting, or `bot` acting for them.
    pub fn acting(user: MacroUserIdStr<'static>, bot: Option<bot_id::BotId>) -> Self {
        match bot {
            Some(bot) => Self {
                actor: Actor::new_from_bot(bot),
                on_behalf_of: Some(user),
            },
            None => Self::user(user),
        }
    }
}

/// Metadata for [`CampaignTopicEvent::Created`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignCreatedMetadata {
    /// The new campaign.
    pub campaign_id: Uuid,
    /// Its owner.
    pub owner: MacroUserIdStr<'static>,
    /// Its name.
    pub name: String,
    /// When it was created.
    pub created_at: DateTime<Utc>,
    /// Who created it.
    pub attribution: Attribution,
}

/// Metadata for [`CampaignTopicEvent::Renamed`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignRenamedMetadata {
    /// The campaign.
    pub campaign_id: Uuid,
    /// Who renamed it; `None` for internal callers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<Attribution>,
    /// Its new name.
    pub name: String,
}

/// Metadata for the events that name only the campaign and who acted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignChangedMetadata {
    /// The campaign.
    pub campaign_id: Uuid,
    /// Who acted; `None` for internal callers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<Attribution>,
}

/// Events that can be published to [`MacroCampaignsTopic`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event_type", content = "metadata")]
pub enum CampaignTopicEvent {
    /// A campaign was created.
    #[serde(rename = "campaign.created")]
    Created(CampaignCreatedMetadata),
    /// A campaign's name changed.
    #[serde(rename = "campaign.renamed")]
    Renamed(CampaignRenamedMetadata),
    /// A campaign was moved to the trash.
    #[serde(rename = "campaign.trashed")]
    Trashed(CampaignChangedMetadata),
    /// A trashed campaign was brought back.
    #[serde(rename = "campaign.restored")]
    Restored(CampaignChangedMetadata),
    /// A campaign started, or resumed, sending.
    #[serde(rename = "campaign.launched")]
    Launched(CampaignChangedMetadata),
    /// A sending campaign was paused.
    #[serde(rename = "campaign.paused")]
    Paused(CampaignChangedMetadata),
}

impl TopicEvent for CampaignTopicEvent {
    type Topic = MacroCampaignsTopic;

    const SCHEMA_VERSION: u8 = 1;
}

impl CampaignTopicEvent {
    /// The campaign the event is about.
    pub fn campaign_id(&self) -> Uuid {
        match self {
            Self::Created(metadata) => metadata.campaign_id,
            Self::Renamed(metadata) => metadata.campaign_id,
            Self::Trashed(metadata)
            | Self::Restored(metadata)
            | Self::Launched(metadata)
            | Self::Paused(metadata) => metadata.campaign_id,
        }
    }
}

/// Publishable event for [`MacroCampaignsTopic`], keyed by campaign id.
pub struct CampaignMacroEvent {
    key: String,
    event: Event<CampaignTopicEvent>,
}

impl CampaignMacroEvent {
    /// Build an event keyed by the campaign it is about.
    pub fn new(event: CampaignTopicEvent) -> Self {
        Self::with_event(event.campaign_id().to_string(), Event::new(event))
    }

    /// Build an event from a pre-built envelope.
    pub fn with_event(key: impl Into<String>, event: Event<CampaignTopicEvent>) -> Self {
        Self {
            key: key.into(),
            event,
        }
    }
}

impl MacroEvent for CampaignMacroEvent {
    type EventPayload = CampaignTopicEvent;

    fn key(&self) -> &str {
        &self.key
    }

    fn event(&self) -> &Event<Self::EventPayload> {
        &self.event
    }

    fn from_event(key: String, event: Event<Self::EventPayload>) -> Self {
        Self::with_event(key, event)
    }
}
