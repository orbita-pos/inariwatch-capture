//! Shared types for the intent compiler.
//!
//! `IntentShape` is intentionally a `serde_json::Value` rather than a
//! typed struct — different sources emit different subsets of the
//! JSON-Schema-flavoured dialect, and locking the spec here would force
//! conversions downstream. The wire payload serializes the shape
//! verbatim; it's opaque to the LLM beyond "this looks like JSON Schema".

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A frame on the call stack — same shape as the Node SDK's
/// `ResolverFrame`. Only `file` is required; `line` and `function`
/// improve resolution but the source must degrade gracefully when they
/// are missing.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolverFrame {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
}

/// JSON-Schema-flavoured shape. See `capture/src/intent/types.ts` for
/// the canonical dialect description (we intentionally mirror it).
pub type IntentShape = Value;

/// Wire payload entry. The compiler attaches one of these per frame
/// that any source could resolve.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntentContract {
    /// Source name — `"serde"`, `"prisma"`, etc.
    pub source: String,
    /// `{file}#{symbol}` — informational, used to disambiguate when
    /// multiple sources resolved the same frame.
    pub path: String,
    /// JSON-Schema-flavoured shape.
    pub shape: IntentShape,
}

/// 10 KB cap on a serialized shape — same as the Node SDK. Keeps payload
/// size predictable when an intent source resolves a deeply nested type.
#[allow(dead_code)] // consumed by `serde_src` (feature-gated)
pub const MAX_SHAPE_BYTES: usize = 10 * 1024;

/// Truncate `shape` so its serialized size fits [`MAX_SHAPE_BYTES`].
/// Replaces nested object/array bodies with `{"_truncated": true}`
/// starting from the deepest leaves.
#[allow(dead_code)] // consumed by `serde_src` (feature-gated)
pub fn cap_shape_size(mut shape: IntentShape) -> IntentShape {
    if let Ok(s) = serde_json::to_string(&shape) {
        if s.len() <= MAX_SHAPE_BYTES {
            return shape;
        }
    }
    for depth in (1..=4).rev() {
        let candidate = truncate_at_depth(&shape, depth);
        if let Ok(s) = serde_json::to_string(&candidate) {
            if s.len() <= MAX_SHAPE_BYTES {
                return candidate;
            }
        }
    }
    // Last resort — collapse to a stub.
    let stub = serde_json::json!({
        "type": shape.get("type").cloned().unwrap_or_else(|| Value::String("object".into())),
        "_truncated": true,
    });
    shape = stub;
    shape
}

#[allow(dead_code)] // helper for cap_shape_size
fn truncate_at_depth(value: &Value, depth: u8) -> Value {
    if depth == 0 {
        let mut out = serde_json::Map::new();
        if let Some(t) = value.get("type") {
            out.insert("type".into(), t.clone());
        }
        if let Some(s) = value.get("_symbol") {
            out.insert("_symbol".into(), s.clone());
        }
        out.insert("_truncated".into(), Value::Bool(true));
        return Value::Object(out);
    }
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if k == "properties" {
                    if let Value::Object(props) = v {
                        let mut next = serde_json::Map::new();
                        for (pk, pv) in props {
                            next.insert(pk.clone(), truncate_at_depth(pv, depth - 1));
                        }
                        out.insert(k.clone(), Value::Object(next));
                        continue;
                    }
                }
                if k == "items" {
                    out.insert(k.clone(), truncate_at_depth(v, depth - 1));
                    continue;
                }
                out.insert(k.clone(), v.clone());
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}
