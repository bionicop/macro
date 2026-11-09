//! When a recipient may be mailed: a local daily window on chosen weekdays.

use super::models::{CampaignError, CampaignSettings};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

/// A parsed sending window in one zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendWindow {
    zone: Tz,
    start_minute: u16,
    end_minute: u16,
    days: u8,
}

/// An IANA zone name, if valid.
pub fn parse_zone(name: &str) -> Option<Tz> {
    name.trim().parse().ok()
}

impl SendWindow {
    /// Validate a campaign's settings and build its default window.
    pub fn from_settings(settings: &CampaignSettings) -> Result<Self, CampaignError> {
        let zone = parse_zone(&settings.time_zone)
            .ok_or(CampaignError::Invalid("Use an IANA time zone such as America/New_York"))?;
        Self::new(
            zone,
            settings.window_start_minute,
            settings.window_end_minute,
            settings.send_days,
        )
    }

    /// Validate a window.
    pub fn new(zone: Tz, start_minute: u16, end_minute: u16, days: u8) -> Result<Self, CampaignError> {
        if start_minute >= end_minute || end_minute > 1440 {
            return Err(CampaignError::Invalid(
                "The sending window must start before it ends, within one day",
            ));
        }
        if days == 0 || days > 0b111_1111 {
            return Err(CampaignError::Invalid("Choose at least one sending day"));
        }
        Ok(Self {
            zone,
            start_minute,
            end_minute,
            days,
        })
    }

    /// The same window in another zone.
    pub fn in_zone(self, zone: Tz) -> Self {
        Self { zone, ..self }
    }

    /// The first instant at or after `earliest` inside the window.
    pub fn next_open(&self, earliest: DateTime<Utc>) -> DateTime<Utc> {
        let local = earliest.with_timezone(&self.zone).naive_local();
        for offset in 0..=7 {
            let date = local.date() + Duration::days(offset);
            if self.days & (1 << date.weekday().num_days_from_monday()) == 0 {
                continue;
            }
            let start = at_minute(date, self.start_minute);
            let end = at_minute(date, self.end_minute);
            let candidate = if offset == 0 { local.max(start) } else { start };
            if candidate < end
                && let Some(instant) = self.resolve(candidate, end)
            {
                return instant.max(earliest);
            }
        }
        earliest
    }

    /// The instant of a local time, moving out of a daylight-saving gap.
    fn resolve(&self, mut local: NaiveDateTime, end: NaiveDateTime) -> Option<DateTime<Utc>> {
        while local < end {
            match self.zone.from_local_datetime(&local) {
                LocalResult::Single(time) | LocalResult::Ambiguous(time, _) => {
                    return Some(time.with_timezone(&Utc));
                }
                LocalResult::None => local += Duration::minutes(15),
            }
        }
        None
    }
}

fn at_minute(date: NaiveDate, minute: u16) -> NaiveDateTime {
    date.and_hms_opt(0, 0, 0).expect("midnight exists") + Duration::minutes(minute.into())
}

#[cfg(test)]
mod test {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn weekdays_nine_to_five(zone: Tz) -> SendWindow {
        SendWindow::new(zone, 9 * 60, 17 * 60, 0b001_1111).unwrap()
    }

    #[test]
    fn inside_the_window_sends_now() {
        let window = weekdays_nine_to_five(Tz::UTC);
        // Monday.
        let now = utc("2026-11-09T10:30:00Z");
        assert_eq!(window.next_open(now), now);
    }

    #[test]
    fn before_the_window_waits_for_it() {
        let window = weekdays_nine_to_five(Tz::UTC);
        assert_eq!(
            window.next_open(utc("2026-11-09T06:00:00Z")),
            utc("2026-11-09T09:00:00Z")
        );
    }

    #[test]
    fn after_the_window_waits_for_the_next_day() {
        let window = weekdays_nine_to_five(Tz::UTC);
        assert_eq!(
            window.next_open(utc("2026-11-09T17:00:00Z")),
            utc("2026-11-10T09:00:00Z")
        );
    }

    #[test]
    fn friday_evening_waits_for_monday() {
        let window = weekdays_nine_to_five(Tz::UTC);
        assert_eq!(
            window.next_open(utc("2026-11-13T18:00:00Z")),
            utc("2026-11-16T09:00:00Z")
        );
    }

    #[test]
    fn the_window_is_local_to_the_recipient() {
        let window = weekdays_nine_to_five(chrono_tz::America::New_York);
        // 08:00 in New York, standard time.
        assert_eq!(
            window.next_open(utc("2026-11-09T13:00:00Z")),
            utc("2026-11-09T14:00:00Z")
        );
    }

    #[test]
    fn a_daylight_saving_gap_moves_forward() {
        // 02:00 to 03:00 does not exist in New York on 8 March 2026.
        let window =
            SendWindow::new(chrono_tz::America::New_York, 2 * 60 + 30, 4 * 60, 0b111_1111).unwrap();
        assert_eq!(
            window.next_open(utc("2026-03-08T05:00:00Z")),
            utc("2026-03-08T07:00:00Z")
        );
    }

    #[test]
    fn a_window_ending_at_midnight_is_accepted() {
        let window = SendWindow::new(Tz::UTC, 22 * 60, 1440, 0b111_1111).unwrap();
        let now = utc("2026-11-09T23:59:00Z");
        assert_eq!(window.next_open(now), now);
    }

    #[test]
    fn invalid_windows_are_refused() {
        assert!(SendWindow::new(Tz::UTC, 600, 600, 1).is_err());
        assert!(SendWindow::new(Tz::UTC, 0, 1441, 1).is_err());
        assert!(SendWindow::new(Tz::UTC, 0, 60, 0).is_err());
        assert!(parse_zone("Mars/Olympus").is_none());
    }
}
