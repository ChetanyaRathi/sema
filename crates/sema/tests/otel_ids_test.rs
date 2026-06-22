//! Gap-2: a caller-supplied conversation / session / user identity flows to every
//! span (Langfuse Sessions + Users). Own binary (global provider is process-global).

#![cfg(not(target_arch = "wasm32"))]

use sema_eval::Interpreter;
use sema_llm::builtins::{register_test_provider, reset_runtime_state};
use sema_llm::fake::FakeProvider;

#[test]
fn agent_run_propagates_caller_supplied_ids() {
    let cap = sema_otel::testing::install();
    let fake = FakeProvider::builder("fake")
        .model("fake-model")
        .reply("done")
        .build();
    let interp = Interpreter::new();
    reset_runtime_state();
    register_test_provider(Box::new(fake));

    let src = r#"
        (defagent bot {:model "fake-model" :tools []})
        (agent/run bot "hi"
          {:conversation-id "conv-abc" :session-id "sess-xyz" :user-id "user-7"})
    "#;
    interp.eval_str_compiled(src).expect("agent/run should run");

    let spans = cap.spans_json();
    let agent = spans
        .iter()
        .find(|s| s["attributes"]["gen_ai.operation.name"] == "invoke_agent")
        .expect("agent span");
    assert_eq!(agent["attributes"]["gen_ai.conversation.id"], "conv-abc");
    assert_eq!(agent["attributes"]["session.id"], "sess-xyz");
    assert_eq!(agent["attributes"]["user.id"], "user-7");

    // The nested chat span inherits the same identity.
    let chat = spans
        .iter()
        .find(|s| s["attributes"]["gen_ai.operation.name"] == "chat")
        .expect("chat span");
    assert_eq!(chat["attributes"]["gen_ai.conversation.id"], "conv-abc");
    assert_eq!(chat["attributes"]["session.id"], "sess-xyz");
    assert_eq!(chat["attributes"]["user.id"], "user-7");
}
