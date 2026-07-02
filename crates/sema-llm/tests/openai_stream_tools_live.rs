//! Live test: OpenAI streaming must accumulate tool-call deltas into the final response.
//! Key-gated + `#[ignore]` (run with `OPENAI_API_KEY=… cargo test -p sema-llm --test
//! openai_stream_tools_live -- --ignored --nocapture`). Verifies the fix for the bug where
//! `stream_complete` returned `tool_calls: Vec::new()`, dropping streamed tool calls.

use sema_llm::openai::OpenAiProvider;
use sema_llm::provider::LlmProvider;
use sema_llm::types::{ChatMessage, ChatRequest, ToolSchema};

#[test]
#[ignore = "requires OPENAI_API_KEY; live network"]
fn openai_stream_accumulates_tool_calls() {
    let key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY must be set");
    let provider =
        OpenAiProvider::new(key, None, Some("gpt-5.4-mini".to_string())).expect("build provider");

    let mut request = ChatRequest::new(
        "gpt-5.4-mini".to_string(),
        vec![ChatMessage::new(
            "user",
            "What is the weather in Oslo? You must call the get_weather tool.",
        )],
    );
    request.tools = vec![ToolSchema {
        name: "get_weather".to_string(),
        description: "Get the current weather for a city".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"]
        }),
    }];

    let mut chunks = String::new();
    let resp = provider
        .stream_complete(request, &mut |c| {
            chunks.push_str(c);
            Ok(())
        })
        .expect("stream_complete should succeed");

    assert!(
        !resp.tool_calls.is_empty(),
        "streamed response must carry the accumulated tool call (got none); content={:?}",
        resp.content
    );
    let tc = &resp.tool_calls[0];
    assert_eq!(tc.name, "get_weather", "tool name should be get_weather");
    // arguments must be valid JSON assembled from the streamed fragments
    assert!(
        tc.arguments.get("city").is_some(),
        "tool arguments should include :city, got {:?}",
        tc.arguments
    );
    println!(
        "OK: streamed tool call {} args={} ({} content chars)",
        tc.name,
        tc.arguments,
        chunks.len()
    );
}
