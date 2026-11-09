//! Driving adapters.

/// HTTP routes, mounted at `/campaigns`.
#[cfg(feature = "inbound")]
pub mod axum_router;
/// Sending identity routes, merged into the campaign routes.
#[cfg(feature = "inbound")]
pub mod identity_router;
/// Unauthenticated unsubscribe and open-pixel routes, checked by signature.
#[cfg(feature = "inbound")]
pub mod public_router;
/// Agent tools.
#[cfg(feature = "ai_tools")]
pub mod toolset;
