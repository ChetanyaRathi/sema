//! MCP-call cassette hook — a crate-neutral seam so `sema-mcp` can record/replay
//! tool calls through the LLM cassette that lives in `sema-llm`, without a
//! dependency edge between the two crates.
//!
//! `sema-llm` owns the tape and installs the hook at interpreter init (function
//! pointers into its thread-local cassette, exactly like `set_eval_callback`);
//! `sema-mcp` consults the hook around each real `tools/call`. When no cassette
//! is active the hook is absent and calls pass straight through.

use std::cell::RefCell;

use serde_json::Value;

/// What to do for an MCP tool call under an active cassette.
pub enum McpCassetteDecision {
    /// Serve this recorded result — do NOT touch the network.
    Replay(Value),
    /// Replay mode with no matching entry — a hard miss (surfaces drift).
    Miss,
    /// Perform the real call, then record the result.
    Record,
}

type DecideFn = fn(&str) -> McpCassetteDecision;
type RecordFn = fn(&str, &Value);

thread_local! {
    static HOOK: RefCell<Option<(DecideFn, RecordFn)>> = const { RefCell::new(None) };
}

/// Register the cassette hook. Called by `sema-llm` when a cassette is active.
pub fn set_mcp_cassette_hook(decide: DecideFn, record: RecordFn) {
    HOOK.with(|h| *h.borrow_mut() = Some((decide, record)));
}

/// Remove the cassette hook (calls pass straight through afterwards).
pub fn clear_mcp_cassette_hook() {
    HOOK.with(|h| *h.borrow_mut() = None);
}

/// Decide how to handle an MCP call for `key`; `None` when no cassette is active.
pub fn mcp_cassette_decide(key: &str) -> Option<McpCassetteDecision> {
    HOOK.with(|h| {
        let hook = h.borrow();
        hook.as_ref().map(|&(decide, _)| decide(key))
    })
}

/// Record an MCP call result under `key`. No-op when no cassette is active.
pub fn mcp_cassette_record(key: &str, value: &Value) {
    HOOK.with(|h| {
        if let Some(&(_, record)) = h.borrow().as_ref() {
            record(key, value);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    thread_local! {
        static TEST_TAPE: RefCell<HashMap<String, Value>> = RefCell::new(HashMap::new());
    }

    fn test_decide(key: &str) -> McpCassetteDecision {
        TEST_TAPE.with(|t| match t.borrow().get(key) {
            Some(v) => McpCassetteDecision::Replay(v.clone()),
            None => McpCassetteDecision::Record,
        })
    }

    fn test_record(key: &str, value: &Value) {
        TEST_TAPE.with(|t| {
            t.borrow_mut().insert(key.to_string(), value.clone());
        });
    }

    #[test]
    fn hook_routes_decide_and_record() {
        // No hook → transparent.
        assert!(mcp_cassette_decide("k").is_none());
        mcp_cassette_record("k", &serde_json::json!({"ignored": true})); // no-op, must not panic

        set_mcp_cassette_hook(test_decide, test_record);
        // Unknown key → Record.
        assert!(matches!(
            mcp_cassette_decide("k"),
            Some(McpCassetteDecision::Record)
        ));
        // Record then replay the exact value.
        mcp_cassette_record("k", &serde_json::json!({"a": 1}));
        match mcp_cassette_decide("k") {
            Some(McpCassetteDecision::Replay(v)) => assert_eq!(v, serde_json::json!({"a": 1})),
            _ => panic!("expected a replay hit"),
        }

        clear_mcp_cassette_hook();
        assert!(mcp_cassette_decide("k").is_none());
    }
}
