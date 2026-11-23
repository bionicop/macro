use ::activity::{Action, EntityType, activity_id};
use chrono::{TimeZone as _, Utc};
use macro_event_broker::Event;
use macro_user_id::user_id::MacroUserIdStr;
use uuid::Uuid;

use super::*;
use crate::domain::events::{
    Attribution as EventAttribution, CampaignChangedMetadata, CampaignCreatedMetadata,
    CampaignRenamedMetadata,
};

const CAMPAIGN: Uuid = Uuid::from_u128(0xca);

fn user(id: &str) -> MacroUserIdStr<'static> {
    MacroUserIdStr::try_from(id.to_string()).expect("valid user id")
}

fn envelope(event: CampaignTopicEvent) -> Event<CampaignTopicEvent> {
    Event::with_event_id(Uuid::now_v7(), event)
}

fn insert(event: &Event<CampaignTopicEvent>) -> Activity {
    let Ingest::Insert(mut activities) = event.event.ingest(event.event_id) else {
        panic!("this event is activity");
    };
    assert_eq!(activities.len(), 1);
    activities.pop().unwrap()
}

fn changed(attribution: Option<EventAttribution>) -> CampaignChangedMetadata {
    CampaignChangedMetadata {
        campaign_id: CAMPAIGN,
        attribution,
    }
}

#[test]
fn created_is_the_creators_activity_at_creation_time() {
    let created_at = Utc.with_ymd_and_hms(2026, 11, 1, 9, 0, 0).unwrap();
    let event = envelope(CampaignTopicEvent::Created(CampaignCreatedMetadata {
        campaign_id: CAMPAIGN,
        owner: user("macro|ada@example.com"),
        name: "Expo follow-up".into(),
        created_at,
        attribution: EventAttribution::user(user("macro|ada@example.com")),
    }));
    let activity = insert(&event);
    assert_eq!(activity.entity_type, EntityType::Campaign);
    assert_eq!(activity.entity_id, CAMPAIGN.to_string());
    assert_eq!(activity.occurred_at, created_at);
    assert_eq!(activity.action, Action::Created);
    assert_eq!(activity.id, activity_id(event.event_id, 0));
}

#[test]
fn lifecycle_changes_map_to_common_actions_and_launch_to_sent() {
    let ada = || Some(EventAttribution::user(user("macro|ada@example.com")));
    let cases = [
        (
            CampaignTopicEvent::Renamed(CampaignRenamedMetadata {
                campaign_id: CAMPAIGN,
                attribution: ada(),
                name: "New name".into(),
            }),
            Action::Edited,
        ),
        (CampaignTopicEvent::Trashed(changed(ada())), Action::Deleted),
        (CampaignTopicEvent::Restored(changed(ada())), Action::Edited),
        (CampaignTopicEvent::Paused(changed(ada())), Action::Edited),
        (CampaignTopicEvent::Launched(changed(ada())), Action::Sent),
    ];
    for (event, expected) in cases {
        let envelope = envelope(event);
        let activity = insert(&envelope);
        assert_eq!(activity.action, expected);
        assert_eq!(activity.entity_type, EntityType::Campaign);
        assert_eq!(activity.entity_id, CAMPAIGN.to_string());
    }
}

#[test]
fn an_agent_acting_for_a_user_is_attributed_to_both() {
    let on_behalf_of = user("macro|ada@example.com");
    let bot = bot_id::BotId::new_from_uuid(Uuid::from_u128(0xb0));
    let event = envelope(CampaignTopicEvent::Launched(changed(Some(EventAttribution::acting(
        on_behalf_of.clone(),
        Some(bot),
    )))));
    let activity = insert(&event);
    assert_eq!(activity.subject_id, on_behalf_of.to_string());
    assert_eq!(activity.action, Action::Sent);
}

#[test]
fn internal_changes_belong_on_nobodys_feed() {
    for event in [
        CampaignTopicEvent::Renamed(CampaignRenamedMetadata {
            campaign_id: CAMPAIGN,
            attribution: None,
            name: "x".into(),
        }),
        CampaignTopicEvent::Trashed(changed(None)),
        CampaignTopicEvent::Restored(changed(None)),
        CampaignTopicEvent::Paused(changed(None)),
        CampaignTopicEvent::Launched(changed(None)),
    ] {
        let envelope = envelope(event);
        assert!(matches!(envelope.event.ingest(envelope.event_id), Ingest::Ignore));
    }
}

#[test]
fn events_round_trip_through_their_wire_form() {
    let event = CampaignTopicEvent::Launched(changed(Some(EventAttribution::user(user(
        "macro|ada@example.com",
    )))));
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["event_type"], "campaign.launched");
    assert_eq!(serde_json::from_value::<CampaignTopicEvent>(json).unwrap(), event);
    assert_eq!(event.campaign_id(), CAMPAIGN);
}
