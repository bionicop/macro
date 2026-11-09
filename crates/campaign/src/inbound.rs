//! Driving adapters.

/// HTTP routes, mounted at `/campaigns`.
pub mod axum_router;
/// Sending identity routes, merged into the campaign routes.
pub mod identity_router;
/// Unauthenticated unsubscribe and open-pixel routes, checked by signature.
pub mod public_router;
