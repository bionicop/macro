//! Driving adapters.

/// HTTP routes, mounted at `/campaigns`.
pub mod axum_router;
/// Sending identity routes, merged into the campaign routes.
pub mod identity_router;
