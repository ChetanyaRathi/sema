//! Async-offload coverage for the remaining single-shot LLM entry points
//! (WP-LLM-SIMPLE): `llm/chat` without `:tools`, `llm/send`, `conversation/say`,
//! `conversation/say-as`, `llm/summarize`, and `llm/compare`. Each now branches
//! on `in_async_context()` and routes through the existing `do_complete_async_yield`
//! machinery exactly like `llm/complete`/`llm/classify` — so a completion running
//! inside `async/spawn` yields instead of blocking the VM thread for the length
//! of the round-trip.
//!
//! Deterministic + keyless (`FakeProvider`, see AGENTS.md "LLM / agent paths").
//! Unlike `complete_async_test.rs` these tests assert neither otel spans nor the
//! process-global in-flight gauge, so no `sema_otel::testing::install()` /
//! `#[serial]` is needed — `register_test_provider` installs into a thread-local
//! registry, which is safe under parallel `cargo test` execution.

#![cfg(not(target_arch = "wasm32"))]

use std::sync::Arc;

use sema_core::Value;
use sema_eval::Interpreter;
use sema_llm::builtins::{register_test_provider, reset_runtime_state};
use sema_llm::fake::{FakeProvider, FakeRecorder};

/// Build an interpreter, install `fake` as the default provider, run `src`.
/// Returns the eval result plus the recorder handle for asserting on the exact
/// requests the runtime built.
fn eval_with_fake(
    src: &str,
    fake: FakeProvider,
) -> (Result<Value, sema_core::SemaError>, Arc<FakeRecorder>) {
    let interp = Interpreter::new();
    reset_runtime_state();
    let recorder = fake.recorder();
    register_test_provider(Box::new(fake));
    let result = interp.eval_str_compiled(src);
    (result, recorder)
}

/// Extract the ordered list of channel receives from a `(list a b)` result of
/// two `channel/recv` calls, as strings — the deterministic ordering oracle
/// shared by the sibling-ordering tests below (never a wall-clock assert).
fn received_strings(val: &Value) -> Vec<String> {
    val.as_list()
        .expect("channel receives list")
        .iter()
        .map(|v| v.as_str().expect("string value").to_string())
        .collect()
}

// ── llm/chat (no :tools) ─────────────────────────────────────────────

#[test]
fn chat_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("chat reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(async/await (async/spawn (fn ()
             (llm/chat (list (message :user "hi")) {:model "fake-chat"}))))"#,
        fake,
    );
    let val = result.expect("llm/chat inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("chat reply"));
    assert_eq!(recorder.call_count(), 1);
}

/// Scheduler-not-stalled: `llm/chat`'s completion is slow (`chat_delay`); a
/// sibling task's short sleep must land on the channel FIRST — proving the
/// completion is offloaded off the VM thread, not blocking it for the
/// round-trip. Ordering via channel receive order, never a duration assert.
#[test]
fn chat_async_lets_sibling_run_first() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .chat_delay(200)
        .reply("chat reply")
        .build();
    let (result, _recorder) = eval_with_fake(
        r#"
        (let ((out (channel/new 8)))
          (async/all
            (list
              (async/spawn (fn () (channel/send out (llm/chat (list (message :user "hi")) {:model "fake-chat"}))))
              (async/spawn (fn () (sleep 20) (channel/send out "sibling")))))
          (list (channel/recv out) (channel/recv out)))
        "#,
        fake,
    );
    let received = received_strings(&result.expect("chat sibling-ordering program evaluated"));
    assert_eq!(received.len(), 2);
    let sibling_pos = received
        .iter()
        .position(|v| v == "sibling")
        .expect("sibling value received");
    let chat_pos = received
        .iter()
        .position(|v| v == "chat reply")
        .expect("chat result received");
    assert!(
        sibling_pos < chat_pos,
        "sibling task must complete while llm/chat's completion is in flight, got {received:?}"
    );
}

/// Cache hit on the async path returns WITHOUT a provider call (recorder stays
/// at 1 — only the priming call) and reports zero usage, matching the
/// synchronous accounting invariant (AGENTS.md "Accounting invariant").
#[test]
fn chat_async_cache_hit_returns_without_provider_call() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply_with_usage("cached!", 100, 50)
        .build();
    let (result, recorder) = eval_with_fake(
        r#"
        (llm/cache-clear)
        (llm/with-cache {:ttl 3600}
          (fn ()
            (llm/chat (list (message :user "same")) {:model "fake-chat"})
            (async/all
              (map (fn (_) (async/spawn (fn () (llm/chat (list (message :user "same")) {:model "fake-chat"}))))
                   (list 1 2)))))
        (:total-tokens (llm/session-usage))
        "#,
        fake,
    );
    let val = result.expect("cache-hit-in-async program evaluated");
    assert_eq!(
        val.as_int(),
        Some(150),
        "cache hits must add 0 usage; only the priming call counts"
    );
    assert_eq!(
        recorder.call_count(),
        1,
        "only the priming call hits the provider; concurrent calls served from cache"
    );
}

#[test]
fn chat_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sync chat reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(llm/chat (list (message :user "hi")) {:model "fake-chat"})"#,
        fake,
    );
    let val = result.expect("llm/chat at top level should succeed");
    assert_eq!(val.as_str(), Some("sync chat reply"));
    assert_eq!(recorder.call_count(), 1);
}

// ── llm/send ─────────────────────────────────────────────────────────

#[test]
fn send_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sent reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(async/await (async/spawn (fn () (llm/send (prompt (user "hi")) {:model "fake-chat"}))))"#,
        fake,
    );
    let val = result.expect("llm/send inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("sent reply"));
    assert_eq!(recorder.call_count(), 1);
}

#[test]
fn send_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sync sent reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(llm/send (prompt (user "hi")) {:model "fake-chat"})"#,
        fake,
    );
    let val = result.expect("llm/send at top level should succeed");
    assert_eq!(val.as_str(), Some("sync sent reply"));
    assert_eq!(recorder.call_count(), 1);
}

// ── conversation/say ────────────────────────────────────────────────

#[test]
fn conversation_say_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("assistant reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (async/await (async/spawn (fn () (conversation/last-reply (conversation/say c "hi")))))
        "#,
        fake,
    );
    let val = result.expect("conversation/say inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("assistant reply"));
    assert_eq!(recorder.call_count(), 1);
}

/// Scheduler-not-stalled proof for `conversation/say`, same shape as the
/// `llm/chat` one above.
#[test]
fn conversation_say_async_lets_sibling_run_first() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .chat_delay(200)
        .reply("assistant reply")
        .build();
    let (result, _recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (let ((out (channel/new 8)))
          (async/all
            (list
              (async/spawn (fn () (channel/send out (conversation/last-reply (conversation/say c "hi")))))
              (async/spawn (fn () (sleep 20) (channel/send out "sibling")))))
          (list (channel/recv out) (channel/recv out)))
        "#,
        fake,
    );
    let received =
        received_strings(&result.expect("conversation/say sibling-ordering program evaluated"));
    assert_eq!(received.len(), 2);
    let sibling_pos = received
        .iter()
        .position(|v| v == "sibling")
        .expect("sibling value received");
    let say_pos = received
        .iter()
        .position(|v| v == "assistant reply")
        .expect("say result received");
    assert!(
        sibling_pos < say_pos,
        "sibling task must complete while conversation/say's completion is in flight, got {received:?}"
    );
}

/// Conversation state mutation (history append + usage-metadata accumulation)
/// must land AFTER the resumed result arrives, on the VM thread — never inside
/// the offload. Proven end-to-end: usage tallied into the new conversation's
/// metadata through the async path matches what the sync path would record.
#[test]
fn conversation_say_async_accounts_usage_in_metadata() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply_with_usage("assistant reply", 20, 10)
        .build();
    let (result, _recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (define c2 (async/await (async/spawn (fn () (conversation/say c "hi")))))
        (:total (:tokens (conversation/stats c2)))
        "#,
        fake,
    );
    let val = result.expect("conversation/say async usage-accounting program evaluated");
    assert_eq!(
        val.as_int(),
        Some(30),
        "usage metadata must accumulate through the async path exactly as the sync path"
    );
}

#[test]
fn conversation_say_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sync assistant reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (conversation/last-reply (conversation/say c "hi"))
        "#,
        fake,
    );
    let val = result.expect("conversation/say at top level should succeed");
    assert_eq!(val.as_str(), Some("sync assistant reply"));
    assert_eq!(recorder.call_count(), 1);
}

// ── conversation/say-as ─────────────────────────────────────────────

#[test]
fn conversation_say_as_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("terse reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (async/await (async/spawn (fn () (conversation/last-reply (conversation/say-as c "Be terse." "hi")))))
        "#,
        fake,
    );
    let val = result.expect("conversation/say-as inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("terse reply"));
    assert_eq!(recorder.call_count(), 1);
}

#[test]
fn conversation_say_as_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sync terse reply")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"
        (define c (conversation/new {:model "fake-chat"}))
        (conversation/last-reply (conversation/say-as c "Be terse." "hi"))
        "#,
        fake,
    );
    let val = result.expect("conversation/say-as at top level should succeed");
    assert_eq!(val.as_str(), Some("sync terse reply"));
    assert_eq!(recorder.call_count(), 1);
}

// ── llm/summarize ───────────────────────────────────────────────────

#[test]
fn summarize_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("a short summary")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(async/await (async/spawn (fn () (llm/summarize "a long text to summarize" {:model "fake-chat"}))))"#,
        fake,
    );
    let val = result.expect("llm/summarize inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("a short summary"));
    assert_eq!(recorder.call_count(), 1);
}

#[test]
fn summarize_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply("sync summary")
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(llm/summarize "a long text to summarize" {:model "fake-chat"})"#,
        fake,
    );
    let val = result.expect("llm/summarize at top level should succeed");
    assert_eq!(val.as_str(), Some("sync summary"));
    assert_eq!(recorder.call_count(), 1);
}

// ── llm/compare ─────────────────────────────────────────────────────

#[test]
fn compare_async_completes_inside_spawn() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply(r#"{"similarity": 0.5, "differences": ["x"], "summary": "close"}"#)
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(:summary (async/await (async/spawn (fn () (llm/compare "text a" "text b" {:model "fake-chat"})))))"#,
        fake,
    );
    let val = result.expect("llm/compare inside async/spawn should succeed");
    assert_eq!(val.as_str(), Some("close"));
    assert_eq!(recorder.call_count(), 1);
}

#[test]
fn compare_sync_regression_outside_async() {
    let fake = FakeProvider::builder("fake")
        .model("fake-chat")
        .reply(r#"{"similarity": 0.9, "differences": [], "summary": "sync close"}"#)
        .build();
    let (result, recorder) = eval_with_fake(
        r#"(:summary (llm/compare "text a" "text b" {:model "fake-chat"}))"#,
        fake,
    );
    let val = result.expect("llm/compare at top level should succeed");
    assert_eq!(val.as_str(), Some("sync close"));
    assert_eq!(recorder.call_count(), 1);
}
