#![deny(missing_docs)]
//! Outreach campaigns: a sequence of emails sent to the CRM contacts of a
//! recipient table, behind a domain service with Axum and Postgres adapters.
//! The recipient table is reusable database storage owned by the campaign,
//! exactly as a CRM pipeline owns its board.

pub mod domain;

#[cfg(feature = "inbound")]
pub mod inbound;

#[cfg(feature = "postgres")]
pub mod outbound;
