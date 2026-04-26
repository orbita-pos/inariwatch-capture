//! Intent contracts compiler — Rust parts (SKYNET §3 piece 5, Track D).
//!
//! Mirrors the public surface of `capture/src/intent/` (Node) and
//! `capture/python/src/inariwatch_capture/intent/` (Python). One source
//! lives here today: [`serde_source`], which extracts a JSON-Schema-
//! flavoured shape from `#[derive(Serialize, Deserialize)]` structs in
//! the failing file.
//!
//! `serde_source` is gated behind the `intent-serde` cargo feature. When
//! disabled, [`extract_intent_for_frame`] returns no contracts — the
//! payload v2 envelope still ships, just without a shape hint. This keeps
//! the default build dependency-light (no `syn` in the dep graph) for
//! users who don't care about intent enrichment.

mod types;

#[cfg(feature = "intent-serde")]
mod serde_src;

pub use types::{IntentContract, IntentShape, ResolverFrame};

#[cfg(feature = "intent-serde")]
pub use serde_src::{serde_source, SerdeSource};

/// Trait implemented by every source. Implementations MUST be:
///   - **pure** in the no-side-effects sense (cache-mutating internal
///     state is fine, but no global mutation observable to callers);
///   - **cheap on misses** — most frames will not have a contract;
///   - **deterministic** — same input → same output.
pub trait IntentSource: Send + Sync {
    /// Stable identifier — appears as the `source` field in the wire
    /// payload's `intent_contracts[]` entries. Stick to lowercase kebab
    /// case (`"serde"`, `"prisma"`, `"openapi"`).
    fn name(&self) -> &'static str;

    /// Resolve a shape for `frame`. Return `None` when this source can't
    /// help (file outside this source's scope, no symbol match, parse
    /// error, peer dep absent, …) so the next source gets a turn.
    fn extract(&self, frame: &ResolverFrame) -> Option<IntentShape>;
}

/// Run every registered source and collect non-empty contracts. Order
/// is determined by the sources slice the caller passes in — the Node
/// SDK uses `[ts, zod, openapi, drizzle, prisma, graphql]`; in Rust we
/// only have `serde` today.
pub fn extract_contracts(
    sources: &[Box<dyn IntentSource>],
    frame: &ResolverFrame,
) -> Vec<IntentContract> {
    sources
        .iter()
        .filter_map(|s| {
            s.extract(frame).map(|shape| IntentContract {
                source: s.name().to_string(),
                path: format!("{}#{}", frame.file, frame.function.as_deref().unwrap_or("?")),
                shape,
            })
        })
        .collect()
}

/// Convenience helper for callers that don't want to manage source
/// registration. Returns whatever the default set produces. With the
/// `intent-serde` feature enabled, that's `[serde_source()]`; without
/// it, an empty vector.
pub fn extract_intent_for_frame(frame: &ResolverFrame) -> Vec<IntentContract> {
    let sources = default_sources();
    extract_contracts(&sources, frame)
}

#[cfg(feature = "intent-serde")]
fn default_sources() -> Vec<Box<dyn IntentSource>> {
    vec![Box::new(serde_source())]
}

#[cfg(not(feature = "intent-serde"))]
fn default_sources() -> Vec<Box<dyn IntentSource>> {
    Vec::new()
}
