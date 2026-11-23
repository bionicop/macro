//! A campaign's recipients as a CSV file, for a spreadsheet or another tool.
//!
//! Modelled on Sellbird's list export (AGPL-3.0, github.com/ethanplusai/sellbird,
//! `sellbird/export.py`): fixed column order and one header row. Names come from
//! contacts, and a spreadsheet runs a cell that starts with `=`, so every cell is
//! neutralised before it is written.

use super::models::Recipient;

/// Column order of the file.
pub const COLUMNS: [&str; 8] = [
    "email",
    "name",
    "state",
    "next_step",
    "next_send_at",
    "time_zone",
    "contact_id",
    "enrolled_at",
];

/// Recipients as RFC 4180 CSV, header first, `\r\n` between records.
pub fn recipients_csv(recipients: &[Recipient]) -> String {
    let mut out = COLUMNS.join(",");
    out.push_str("\r\n");
    for recipient in recipients {
        let cells = [
            recipient.email.clone(),
            recipient.name.clone().unwrap_or_default(),
            recipient.state.as_str().to_string(),
            // Positions already count from one, like the steps people see.
            recipient.next_position.to_string(),
            recipient.next_send_at.map(|at| at.to_rfc3339()).unwrap_or_default(),
            recipient.time_zone.clone().unwrap_or_default(),
            recipient.contact_id.map(|id| id.to_string()).unwrap_or_default(),
            recipient.enrolled_at.to_rfc3339(),
        ];
        let row: Vec<String> = cells.iter().map(|cell| cell_text(cell)).collect();
        out.push_str(&row.join(","));
        out.push_str("\r\n");
    }
    out
}

/// One cell: stop a spreadsheet formula, then quote when needed.
fn cell_text(value: &str) -> String {
    let value = value.trim();
    let safe = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if safe.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::domain::models::RecipientState;
    use chrono::{TimeZone, Utc};
    use databases::domain::models::RowId;
    use uuid::Uuid;

    fn recipient(email: &str, name: Option<&str>) -> Recipient {
        Recipient {
            row_id: RowId::from_uuid(Uuid::nil()),
            contact_id: None,
            email: email.into(),
            name: name.map(Into::into),
            time_zone: Some("Europe/Oslo".into()),
            state: RecipientState::Active,
            next_position: 1,
            next_send_at: Some(Utc.with_ymd_and_hms(2026, 11, 12, 9, 0, 0).unwrap()),
            enrolled_at: Utc.with_ymd_and_hms(2026, 11, 11, 8, 30, 0).unwrap(),
        }
    }

    #[test]
    fn writes_a_header_and_one_line_per_recipient() {
        let csv = recipients_csv(&[recipient("ada@example.com", Some("Ada Lovelace"))]);
        assert_eq!(
            csv,
            "email,name,state,next_step,next_send_at,time_zone,contact_id,enrolled_at\r\n\
             ada@example.com,Ada Lovelace,active,1,2026-11-12T09:00:00+00:00,Europe/Oslo,,2026-11-11T08:30:00+00:00\r\n"
        );
    }

    #[test]
    fn quotes_commas_quotes_and_line_breaks() {
        let csv = recipients_csv(&[recipient("ada@example.com", Some("Lovelace, \"Ada\"\nCountess"))]);
        assert!(csv.contains("\"Lovelace, \"\"Ada\"\"\nCountess\""));
    }

    #[test]
    fn spreadsheet_formulas_are_neutralised() {
        let csv = recipients_csv(&[recipient("ada@example.com", Some("=HYPERLINK(\"http://x\")"))]);
        assert!(csv.contains("'=HYPERLINK"));
        assert!(!csv.contains(",=HYPERLINK") && !csv.contains(",\"=HYPERLINK"));
        assert_eq!(cell_text("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(cell_text("-1+1"), "'-1+1");
        assert_eq!(cell_text("plain"), "plain");
    }
}
