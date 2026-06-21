//! M1 acceptance: deterministic OTel span assertions for the LLM call path, using a
//! scripted `FakeProvider` + an in-memory span exporter. No network, no API keys.
//!
//! One test fn (the in-memory exporter + global provider are process-global; a single
//! sequential test avoids cross-test span contamination).

#![cfg(not(target_arch = "wasm32"))]

use sema_eval::Interpreter;
use sema_llm::builtins::{register_test_provider, reset_runtime_state};
use sema_llm::fake::FakeProvider;
use serde_json::json;

#[test]
fn llm_completion_emits_genai_chat_span() {
    let cap = sema_otel::testing::install();

    // ping → provider call; then a cached pair where the 2nd is a cache hit.
    let fake = FakeProvider::builder("fake")
        .model("fake-model")
        .reply_with_usage("pong", 12, 3)
        .reply_with_usage("answer", 50, 8)
        .build();

    let interp = Interpreter::new();
    reset_runtime_state();
    register_test_provider(Box::new(fake));

    let src = r#"
        (llm/cache-clear)
        (llm/complete "ping" {:max-tokens 10})
        (llm/with-cache {:ttl 3600}
          (fn () (llm/complete "q") (llm/complete "q")))
    "#;
    interp
        .eval_str_compiled(src)
        .expect("script should run against the fake");

    let spans = cap.spans_json();
    let chat: Vec<_> = spans
        .iter()
        .filter(|s| s["attributes"]["gen_ai.operation.name"] == "chat")
        .collect();
    assert!(
        chat.len() >= 3,
        "expected >=3 chat spans (ping, q-miss, q-hit), got {}: {:#?}",
        chat.len(),
        spans
    );

    // The ping span: CLIENT, provider + model + usage + finish reason, named per spec.
    let ping = chat
        .iter()
        .find(|s| s["attributes"]["gen_ai.usage.input_tokens"] == 12)
        .expect("ping chat span with 12 input tokens");
    assert_eq!(ping["kind"], "client");
    assert_eq!(ping["name"], "chat fake-model");
    assert_eq!(ping["attributes"]["gen_ai.provider.name"], "fake");
    assert_eq!(ping["attributes"]["gen_ai.request.model"], "fake-model");
    assert_eq!(ping["attributes"]["gen_ai.response.model"], "fake-model");
    assert_eq!(ping["attributes"]["gen_ai.usage.output_tokens"], 3);
    assert_eq!(
        ping["attributes"]["gen_ai.response.finish_reasons"],
        json!(["end_turn"])
    );

    // The cache-hit span: gen_ai.cache.hit=true, zero usage, no provider attribute.
    let hit = chat
        .iter()
        .find(|s| s["attributes"]["gen_ai.cache.hit"] == true)
        .expect("a cache-hit chat span");
    assert_eq!(hit["attributes"]["gen_ai.usage.input_tokens"], 0);
    assert_eq!(hit["attributes"]["gen_ai.usage.output_tokens"], 0);
    assert!(
        hit["attributes"].get("gen_ai.provider.name").is_none(),
        "cache hit has no serving provider"
    );
}
