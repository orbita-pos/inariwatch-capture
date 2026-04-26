//! Intent compiler — `serde` source tests (SKYNET §3 piece 5, Track D, part 3).
//!
//! Exercises:
//!   - direct symbol match resolves the matching struct
//!   - `Type::method` symbol falls back to the receiver type
//!   - Option<T> fields are NOT in `required`
//!   - `#[serde(rename = "x")]` renames the property in the shape
//!   - `#[serde(default)]` removes the field from `required`
//!   - cache invalidates on file change
//!   - file without any `derive(` returns no shape (cheap pre-filter)
//!   - tuple structs degrade gracefully
//!
//! Only compiled when the `intent-serde` feature is enabled — without it
//! the source is a no-op factory and there is nothing to test.

#![cfg(feature = "intent-serde")]

use inariwatch_capture::intent::{
    extract_intent_for_frame, IntentSource, ResolverFrame,
};
use std::fs;
use std::path::PathBuf;

fn write_temp(name: &str, contents: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("inari-intent-test-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("mkdir tmp");
    let path = dir.join(name);
    fs::write(&path, contents).expect("write fixture");
    path
}

fn frame(file: &PathBuf, function: Option<&str>) -> ResolverFrame {
    ResolverFrame {
        file: file.to_string_lossy().into_owned(),
        line: Some(1),
        function: function.map(|s| s.to_string()),
    }
}

#[test]
fn resolves_struct_by_symbol() {
    let path = write_temp(
        "by_symbol.rs",
        r#"
            use serde::{Deserialize, Serialize};
            #[derive(Serialize, Deserialize)]
            pub struct CreateUserRequest {
                pub email: String,
                pub age: u32,
            }
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("CreateUserRequest")));
    assert_eq!(contracts.len(), 1, "expected 1 contract, got {:?}", contracts);
    let c = &contracts[0];
    assert_eq!(c.source, "serde");
    assert_eq!(c.shape["type"], "object");
    assert_eq!(c.shape["_symbol"], "CreateUserRequest");
    assert_eq!(c.shape["properties"]["email"]["type"], "string");
    assert_eq!(c.shape["properties"]["age"]["type"], "number");
    let required = c.shape["required"].as_array().unwrap();
    assert!(required.iter().any(|v| v == "email"));
    assert!(required.iter().any(|v| v == "age"));
}

#[test]
fn option_field_not_required() {
    let path = write_temp(
        "with_option.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Foo {
                pub a: String,
                pub b: Option<i32>,
            }
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Foo")));
    let c = &contracts[0];
    let required: Vec<&str> = c.shape["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(required.contains(&"a"));
    assert!(!required.contains(&"b"), "Option<i32> must not be required");
    // Option unwrap: b should be a `number`, not the Option wrapper.
    assert_eq!(c.shape["properties"]["b"]["type"], "number");
}

#[test]
fn serde_default_drops_required() {
    let path = write_temp(
        "with_default.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Foo {
                pub keep: String,
                #[serde(default)]
                pub maybe: String,
            }
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Foo")));
    let required: Vec<&str> = contracts[0].shape["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(required.contains(&"keep"));
    assert!(!required.contains(&"maybe"), "#[serde(default)] must drop required");
}

#[test]
fn serde_rename_changes_property_name() {
    let path = write_temp(
        "with_rename.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Foo {
                #[serde(rename = "userEmail")]
                pub user_email: String,
            }
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Foo")));
    let props = &contracts[0].shape["properties"];
    assert!(props.get("userEmail").is_some(), "rename must apply, got {:?}", props);
    assert!(props.get("user_email").is_none());
}

#[test]
fn collections_become_arrays() {
    let path = write_temp(
        "with_collections.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Foo {
                pub tags: Vec<String>,
                pub matrix: Vec<Vec<u32>>,
            }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("Foo")))[0];
    assert_eq!(c.shape["properties"]["tags"]["type"], "array");
    assert_eq!(c.shape["properties"]["tags"]["items"]["type"], "string");
    assert_eq!(c.shape["properties"]["matrix"]["type"], "array");
    assert_eq!(c.shape["properties"]["matrix"]["items"]["type"], "array");
    assert_eq!(c.shape["properties"]["matrix"]["items"]["items"]["type"], "number");
}

#[test]
fn hashmap_becomes_additional_properties() {
    let path = write_temp(
        "with_map.rs",
        r#"
            use serde::Deserialize;
            use std::collections::HashMap;
            #[derive(Deserialize)]
            pub struct Foo {
                pub headers: HashMap<String, String>,
            }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("Foo")))[0];
    let h = &c.shape["properties"]["headers"];
    assert_eq!(h["type"], "object");
    assert_eq!(h["additionalProperties"]["type"], "string");
}

#[test]
fn falls_back_to_first_deserialize() {
    let path = write_temp(
        "fallback.rs",
        r#"
            use serde::{Deserialize, Serialize};
            #[derive(Serialize)]                  // serialize-only — second pick
            pub struct OnlySerialize { pub x: u32 }
            #[derive(Deserialize)]                // first deserialize — wins
            pub struct WantThis { pub a: String }
            #[derive(Deserialize)]
            pub struct AlsoDeserialize { pub b: String }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("DoesNotExist")))[0];
    assert_eq!(c.shape["_symbol"], "WantThis");
}

#[test]
fn type_method_symbol_resolves_receiver() {
    let path = write_temp(
        "method.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct WithImpl { pub a: String }
            impl WithImpl { pub fn handle(&self) {} }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("WithImpl::handle")))[0];
    assert_eq!(c.shape["_symbol"], "WithImpl");
}

#[test]
fn no_derive_returns_empty() {
    let path = write_temp(
        "no_derive.rs",
        r#"
            pub struct Plain { pub a: String }
            pub fn handle() {}
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Plain")));
    assert!(contracts.is_empty(), "expected no contracts, got {:?}", contracts);
}

#[test]
fn malformed_rust_returns_empty() {
    let path = write_temp(
        "malformed.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Broken { pub x: ;;; }   // syn::parse_file rejects this
        "#,
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Broken")));
    assert!(contracts.is_empty());
}

#[test]
fn non_rs_file_returns_empty() {
    let path = write_temp(
        "ignored.txt",
        "#[derive(Deserialize)] pub struct Foo {}",
    );
    let contracts = extract_intent_for_frame(&frame(&path, Some("Foo")));
    assert!(contracts.is_empty());
}

#[test]
fn datetime_emits_format_hint() {
    let path = write_temp(
        "datetime.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)]
            pub struct Event { pub at: DateTime, pub id: Uuid }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("Event")))[0];
    assert_eq!(c.shape["properties"]["at"]["type"], "string");
    assert_eq!(c.shape["properties"]["at"]["format"], "date-time");
    assert_eq!(c.shape["properties"]["id"]["format"], "uuid");
}

#[test]
fn nested_struct_emits_symbol_hint() {
    let path = write_temp(
        "nested.rs",
        r#"
            use serde::Deserialize;
            #[derive(Deserialize)] pub struct Inner { pub a: String }
            #[derive(Deserialize)] pub struct Outer { pub inner: Inner, pub list: Vec<Inner> }
        "#,
    );
    let c = &extract_intent_for_frame(&frame(&path, Some("Outer")))[0];
    assert_eq!(c.shape["properties"]["inner"]["_symbol"], "Inner");
    assert_eq!(c.shape["properties"]["inner"]["type"], "object");
    assert_eq!(c.shape["properties"]["list"]["items"]["_symbol"], "Inner");
}

#[test]
fn name_is_stable() {
    use inariwatch_capture::intent::serde_source;
    let s = serde_source();
    assert_eq!(s.name(), "serde");
}
