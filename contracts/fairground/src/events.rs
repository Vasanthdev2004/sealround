//! NEP-297 events: standard `fairground`, version `1.0.0`.
//!
//! A call may log at most 100 lines and 16 KB, so settlement emits one summary
//! event, never one per bid. Amounts are decimal strings.

use near_sdk::env;
use near_sdk::serde_json::{Value, json};

pub const STANDARD: &str = "fairground";
pub const VERSION: &str = "1.0.0";

/// Logs `EVENT_JSON:{"standard":"fairground","version":"1.0.0","event":..,"data":..}`.
pub fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

/// Lowercase hex of a hash, for event and view fields.
pub fn hex(bytes: &[u8]) -> String {
    fairground_clearing::hash::to_hex(bytes)
}
