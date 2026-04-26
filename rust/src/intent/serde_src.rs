//! `serde` source — extracts a JSON-Schema-flavoured shape from
//! `#[derive(Deserialize)]` (or `Serialize`) structs in the failing
//! `.rs` file (SKYNET §3 piece 5, Track D, part 3).
//!
//! When a Rust handler throws, the most useful "expected" shape is the
//! struct used for `serde_json::from_str` deserialization — the
//! request/event DTO. We discover those structs by parsing the file via
//! the `syn` crate and walking the AST.
//!
//! Strategy mirrors the Node TS source:
//!   1. Cheap pre-check: file ends in `.rs` and contains the literal
//!      `derive(` (very fast; misses on files that only use serde
//!      attributes elsewhere are the cost we pay for not parsing
//!      everything — they degrade to "no contract", never wrong contract).
//!   2. Cache by `(path, mtime)`. Contention low: callers run from a
//!      single panic hook thread.
//!   3. Build two indexes: `by_name` (struct ident → shape) and
//!      `deserialize_only` (those that derive Deserialize specifically,
//!      preferred when symbol resolution misses).
//!   4. Resolve order: symbol matches a struct ident → that struct;
//!      symbol uses `Type::method` form → strip and try again; no
//!      match → first Deserialize-deriving struct → first struct.
//!
//! Parse failures are silent: malformed Rust, syntactic features `syn`
//! doesn't recognise (`syn` 2 covers stable + most nightly), or zero
//! `serde` derives all return `None` and the next source gets a turn.

use crate::intent::types::{cap_shape_size, IntentShape, ResolverFrame};
use crate::intent::IntentSource;
use parking_lot::Mutex;
use serde_json::{json, Map as JsonMap, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB

/// Stable name surfaced on the wire payload's `intent_contracts[].source`
/// field. Match the Node SDK's `"serde"` (also used by Pydantic/Zod —
/// the family is "schema lib that drives runtime validation").
const SOURCE_NAME: &str = "serde";

/// Public factory — usually called once and registered with the intent
/// compiler. The returned source caches parse results across calls.
pub fn serde_source() -> SerdeSource {
    SerdeSource {
        cache: Arc::new(Mutex::new(HashMap::new())),
    }
}

#[derive(Clone)]
pub struct SerdeSource {
    cache: Arc<Mutex<HashMap<String, CacheEntry>>>,
}

#[derive(Clone)]
struct CacheEntry {
    mtime: SystemTime,
    parsed: ParsedFile,
}

#[derive(Clone, Default)]
struct ParsedFile {
    /// Struct name → shape.
    by_name: HashMap<String, IntentShape>,
    /// Struct names that derive `Deserialize` (preferred fallback).
    deserialize_only: Vec<String>,
    /// All struct names in source order (final fallback).
    in_order: Vec<String>,
}

impl IntentSource for SerdeSource {
    fn name(&self) -> &'static str {
        SOURCE_NAME
    }

    fn extract(&self, frame: &ResolverFrame) -> Option<IntentShape> {
        let path = &frame.file;
        if !path.ends_with(".rs") {
            return None;
        }
        let p = Path::new(path);
        let meta = fs::metadata(p).ok()?;
        if meta.len() > MAX_FILE_BYTES {
            return None;
        }
        let mtime = meta.modified().ok()?;

        let parsed = {
            let mut cache = self.cache.lock();
            if let Some(entry) = cache.get(path) {
                if entry.mtime == mtime {
                    entry.parsed.clone()
                } else {
                    let fresh = parse_file(p)?;
                    cache.insert(path.clone(), CacheEntry { mtime, parsed: fresh.clone() });
                    fresh
                }
            } else {
                let fresh = parse_file(p)?;
                cache.insert(path.clone(), CacheEntry { mtime, parsed: fresh.clone() });
                fresh
            }
        };

        if parsed.in_order.is_empty() {
            return None;
        }

        let symbol = frame.function.as_deref();
        let chosen = resolve(&parsed, symbol)?;
        let shape = parsed.by_name.get(&chosen)?.clone();
        Some(cap_shape_size(shape))
    }
}

/// Test-only — drop the cache so changed fixtures parse fresh.
#[doc(hidden)]
pub fn __reset_cache_for_testing(s: &SerdeSource) {
    s.cache.lock().clear();
}

fn resolve(parsed: &ParsedFile, symbol: Option<&str>) -> Option<String> {
    if let Some(sym) = symbol {
        if parsed.by_name.contains_key(sym) {
            return Some(sym.to_string());
        }
        // `Type::method` → try the receiver type.
        if let Some(receiver) = sym.split("::").next() {
            if receiver != sym && parsed.by_name.contains_key(receiver) {
                return Some(receiver.to_string());
            }
        }
        // `Type.method` (rare in Rust but the framework strips this in some
        // cases) — same trick.
        if let Some(receiver) = sym.split('.').next() {
            if receiver != sym && parsed.by_name.contains_key(receiver) {
                return Some(receiver.to_string());
            }
        }
    }
    parsed.deserialize_only.first().cloned().or_else(|| parsed.in_order.first().cloned())
}

// ─── Parsing ─────────────────────────────────────────────────────────────

fn parse_file(path: &Path) -> Option<ParsedFile> {
    let src = fs::read_to_string(path).ok()?;
    if !src.contains("derive(") {
        return None;
    }
    let ast: syn::File = syn::parse_file(&src).ok()?;
    let mut out = ParsedFile::default();

    for item in &ast.items {
        walk_item(item, &mut out);
    }

    if out.in_order.is_empty() {
        return None;
    }
    Some(out)
}

fn walk_item(item: &syn::Item, out: &mut ParsedFile) {
    match item {
        syn::Item::Struct(s) => {
            let derives = read_derives(&s.attrs);
            if !derives.has_serde() {
                return;
            }
            let name = s.ident.to_string();
            let shape = struct_to_shape(s, &name);
            out.by_name.insert(name.clone(), shape);
            out.in_order.push(name.clone());
            if derives.deserialize {
                out.deserialize_only.push(name);
            }
        }
        syn::Item::Mod(m) => {
            // Only recurse into inline modules — `mod foo;` declarations
            // don't have content here and we don't load other files.
            if let Some((_, items)) = &m.content {
                for it in items {
                    walk_item(it, out);
                }
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct Derives {
    serialize: bool,
    deserialize: bool,
}

impl Derives {
    fn has_serde(&self) -> bool {
        self.serialize || self.deserialize
    }
}

fn read_derives(attrs: &[syn::Attribute]) -> Derives {
    let mut d = Derives::default();
    for attr in attrs {
        if !attr.path().is_ident("derive") {
            continue;
        }
        // `attr.parse_nested_meta` gives us each path inside `derive(...)`.
        let _ = attr.parse_nested_meta(|meta| {
            if let Some(ident) = meta.path.get_ident() {
                let s = ident.to_string();
                if s == "Serialize" {
                    d.serialize = true;
                }
                if s == "Deserialize" {
                    d.deserialize = true;
                }
            }
            Ok(())
        });
    }
    d
}

fn struct_to_shape(s: &syn::ItemStruct, name: &str) -> IntentShape {
    let mut props = JsonMap::new();
    let mut required: Vec<Value> = Vec::new();

    match &s.fields {
        syn::Fields::Named(fields) => {
            for f in &fields.named {
                let Some(ident) = &f.ident else { continue };
                let mut field_name = ident.to_string();
                let mut is_optional = false;
                let mut explicit_required = true;

                // `#[serde(rename = "x")]`, `#[serde(skip)]`, `#[serde(default)]`,
                // `#[serde(skip_serializing_if = "...")]`. We don't drop
                // `Skip`-only fields — they still belong in the shape since
                // the LLM cares about the deserialize side, not the serialize
                // side. Adjust if dogfood says otherwise.
                for attr in &f.attrs {
                    if !attr.path().is_ident("serde") {
                        continue;
                    }
                    let _ = attr.parse_nested_meta(|meta| {
                        if meta.path.is_ident("rename") {
                            if let Ok(value) = meta.value() {
                                if let Ok(lit) = value.parse::<syn::LitStr>() {
                                    field_name = lit.value();
                                }
                            }
                        }
                        if meta.path.is_ident("default") {
                            explicit_required = false;
                        }
                        if meta.path.is_ident("skip_deserializing") || meta.path.is_ident("skip") {
                            explicit_required = false;
                        }
                        Ok(())
                    });
                }

                // Detect Option<T> wrapper — those are never required.
                let unwrapped = unwrap_option(&f.ty).inspect(|_| { is_optional = true; });
                let mapped = map_type(unwrapped.as_ref().unwrap_or(&f.ty));

                props.insert(field_name.clone(), mapped);
                if explicit_required && !is_optional {
                    required.push(Value::String(field_name));
                }
            }
        }
        syn::Fields::Unnamed(_) | syn::Fields::Unit => {
            // Tuple/unit structs aren't useful intent shapes — they have
            // no field names. Return an empty object with the symbol hint.
        }
    }

    let mut shape = JsonMap::new();
    shape.insert("type".into(), Value::String("object".into()));
    shape.insert("properties".into(), Value::Object(props));
    shape.insert("required".into(), Value::Array(required));
    shape.insert("_symbol".into(), Value::String(name.to_string()));
    Value::Object(shape)
}

fn unwrap_option(ty: &syn::Type) -> Option<syn::Type> {
    let path = match ty {
        syn::Type::Path(tp) if tp.qself.is_none() => &tp.path,
        _ => return None,
    };
    let last = path.segments.last()?;
    if last.ident != "Option" {
        return None;
    }
    let args = match &last.arguments {
        syn::PathArguments::AngleBracketed(a) => a,
        _ => return None,
    };
    for arg in &args.args {
        if let syn::GenericArgument::Type(t) = arg {
            return Some(t.clone());
        }
    }
    None
}

fn map_type(ty: &syn::Type) -> Value {
    match ty {
        syn::Type::Path(tp) => map_path_type(tp),
        syn::Type::Reference(r) => map_type(&r.elem), // &T → T
        syn::Type::Array(a) => json!({
            "type": "array",
            "items": map_type(&a.elem),
        }),
        syn::Type::Slice(s) => json!({
            "type": "array",
            "items": map_type(&s.elem),
        }),
        syn::Type::Tuple(t) if t.elems.is_empty() => json!({"type": "null"}),
        _ => json!({"type": "unknown"}),
    }
}

fn map_path_type(tp: &syn::TypePath) -> Value {
    let Some(last) = tp.path.segments.last() else {
        return json!({"type": "unknown"});
    };
    let ident = last.ident.to_string();
    match ident.as_str() {
        "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64"
        | "i128" | "isize" | "f32" | "f64" => json!({"type": "number"}),
        "bool" => json!({"type": "boolean"}),
        "String" | "str" | "Cow" | "PathBuf" | "Path" => json!({"type": "string"}),
        "char" => json!({"type": "string"}),
        "Vec" | "VecDeque" | "HashSet" | "BTreeSet" => {
            let inner = first_generic(last).map(|t| map_type(&t)).unwrap_or(json!({"type": "unknown"}));
            json!({"type": "array", "items": inner})
        }
        "HashMap" | "BTreeMap" => {
            let inner = last
                .arguments
                .clone()
                .pipe(|a| match a {
                    syn::PathArguments::AngleBracketed(a) => Some(a),
                    _ => None,
                })
                .and_then(|a| {
                    let mut types = a.args.iter().filter_map(|g| match g {
                        syn::GenericArgument::Type(t) => Some(t.clone()),
                        _ => None,
                    });
                    types.next()?; // skip K
                    types.next() // value type
                })
                .map(|t| map_type(&t))
                .unwrap_or(json!({"type": "unknown"}));
            json!({
                "type": "object",
                "additionalProperties": inner,
            })
        }
        "Uuid" => json!({"type": "string", "format": "uuid"}),
        "DateTime" => json!({"type": "string", "format": "date-time"}),
        "NaiveDate" => json!({"type": "string", "format": "date"}),
        "NaiveDateTime" => json!({"type": "string", "format": "date-time"}),
        "Value" => json!({"type": "unknown"}), // serde_json::Value — anything goes
        _ => {
            // Custom type — probably a user struct. Emit a stub with the
            // `_symbol` hint so a downstream resolver can recurse.
            json!({"type": "object", "_symbol": ident})
        }
    }
}

fn first_generic(seg: &syn::PathSegment) -> Option<syn::Type> {
    let args = match &seg.arguments {
        syn::PathArguments::AngleBracketed(a) => a,
        _ => return None,
    };
    args.args.iter().find_map(|g| match g {
        syn::GenericArgument::Type(t) => Some(t.clone()),
        _ => None,
    })
}

// Tiny helper: lets us write `value.pipe(|v| ...)` for chained matches.
trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}
