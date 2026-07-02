//! Gap-2 privacy (OFF direction): WITHOUT the content-capture flag, message content
//! attributes are absent. Own binary so the env flag + global provider are isolated
//! from the ON test.

#![cfg(not(target_arch = "wasm32"))]

use sema_eval::Interpreter;
use sema_llm::builtins::{register_test_provider, reset_runtime_state};
use sema_llm::fake::FakeProvider;

#[test]
fn content_absent_without_opt_in() {
    // SAFETY: single-threaded test setup; ensure the flag is NOT set.
    unsafe {
        std::env::remove_var("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT");
        std::env::remove_var("SEMA_OTEL_CAPTURE_CONTENT");
    }
    let cap = sema_otel::testing::install();

    let fake = FakeProvider::builder("fake")
        .model("fake-model")
        .reply_with_usage("secret answer", 12, 5)
        .build();
    let interp = Interpreter::new();
    reset_runtime_state();
    register_test_provider(Box::new(fake));

    interp
        .eval_str_compiled(r#"(llm/complete "sensitive question?" {:max-tokens 10})"#)
        .expect("completion should run");

    let span = cap
        .span_named("chat fake-model")
        .expect("a chat span should be emitted");
    for key in [
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
    ] {
        assert!(
            span["attributes"].get(key).is_none(),
            "{key} must be absent without the opt-in flag"
        );
    }
    // Tokens/model are still present (non-sensitive).
    assert_eq!(span["attributes"]["gen_ai.usage.input_tokens"], 12);
}
