//! Backend compatibility layer (`SEMA_OTEL_COMPAT`).
//!
//! Sema emits the canonical OTel GenAI semconv (`gen_ai.*`) by default and renders
//! first-class in any vanilla-OTel backend (Grafana/Tempo, SigNoz, Datadog, Honeycomb,
//! Elastic, New Relic, OpenLIT) and in Logfire/Braintrust — no config. This module adds
//! each non-conforming backend's NATIVE alias keys when `SEMA_OTEL_COMPAT` opts in, so
//! Sema also renders first-class in Phoenix/Arize (OpenInference), Traceloop
//! (OpenLLMetry), LangSmith, and fills Langfuse's native fields.
//!
//! Isolated and mapping-table-driven (like `provider_map.rs`): the emit functions
//! return `Vec<KeyValue>` (empty when the relevant backend isn't active), and `imp.rs`
//! applies them. Zero cost / zero alias attributes when `SEMA_OTEL_COMPAT` is unset.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use opentelemetry::{Array, KeyValue, StringValue, Value};

/// One bit per backend.
#[derive(Clone, Copy)]
pub(crate) struct CompatSet(u8);

impl CompatSet {
    pub(crate) const OPENINFERENCE: u8 = 1 << 0;
    pub(crate) const TRACELOOP: u8 = 1 << 1;
    pub(crate) const LANGSMITH: u8 = 1 << 2;
    pub(crate) const LANGFUSE: u8 = 1 << 3;
    pub(crate) const BRAINTRUST: u8 = 1 << 4;
    const ALL: u8 =
        Self::OPENINFERENCE | Self::TRACELOOP | Self::LANGSMITH | Self::LANGFUSE | Self::BRAINTRUST;

    pub(crate) fn is_empty(self) -> bool {
        self.0 == 0
    }
    fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }
}

static ACTIVE: OnceLock<u8> = OnceLock::new();
/// Test override: `0xFF` is the "unset" sentinel (no real combo reaches it — `ALL` is
/// 31). When set, it bypasses the env-parsed `OnceLock`.
static TEST_OVERRIDE: AtomicU8 = AtomicU8::new(0xFF);

fn parse(tokens: &str) -> u8 {
    let mut bits = 0u8;
    for tok in tokens.split(',') {
        bits |= match tok.trim().to_ascii_lowercase().as_str() {
            "openinference" | "phoenix" | "arize" => CompatSet::OPENINFERENCE,
            "traceloop" | "openllmetry" => CompatSet::TRACELOOP,
            "langsmith" => CompatSet::LANGSMITH,
            "langfuse" => CompatSet::LANGFUSE,
            "braintrust" => CompatSet::BRAINTRUST,
            "all" => CompatSet::ALL,
            _ => 0, // unknown token ignored (never panic)
        };
    }
    bits
}

/// The active backend set. One `OnceLock` load on the fast path; reads a test override
/// first (a sentinel keeps production on the cached path).
pub(crate) fn active() -> CompatSet {
    let ov = TEST_OVERRIDE.load(Ordering::Relaxed);
    if ov != 0xFF {
        return CompatSet(ov);
    }
    CompatSet(*ACTIVE.get_or_init(|| {
        std::env::var("SEMA_OTEL_COMPAT")
            .ok()
            .map(|v| parse(&v))
            .unwrap_or(0)
    }))
}

/// Whether any backend compat is active (so callers can skip data prep cheaply).
pub fn compat_active() -> bool {
    !active().is_empty()
}

/// Test hook: force the active set from a token string (bypasses env).
#[cfg_attr(not(feature = "testing"), allow(dead_code))]
pub(crate) fn set_test_override(tokens: &str) {
    TEST_OVERRIDE.store(parse(tokens), Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Provider back-translation (OpenInference uses its own enums, from the RAW name)
// ---------------------------------------------------------------------------

/// OpenInference `llm.provider` (the hosting provider). Back-translated from the RAW
/// Sema provider name (NOT the already-mapped `gen_ai.provider.name`).
fn openinference_provider(raw: &str) -> &str {
    match raw {
        "gemini" | "vertex" => "google",
        "mistral" => "mistralai",
        "x_ai" | "xai" => "xai",
        other => other, // openai/anthropic/groq/deepseek/perplexity/cohere/ollama pass through
    }
}

/// OpenInference `llm.system` (the AI product family). `None` when there's no enum value.
fn openinference_system(raw: &str) -> Option<&str> {
    match raw {
        "openai" => Some("openai"),
        "anthropic" => Some("anthropic"),
        "gemini" | "vertex" => Some("vertexai"),
        "mistral" => Some("mistralai"),
        "cohere" => Some("cohere"),
        "x_ai" | "xai" => Some("xai"),
        "deepseek" => Some("deepseek"),
        _ => None, // ollama / groq / perplexity: no enum value
    }
}

// ---------------------------------------------------------------------------
// Span-kind tagging (emitted at every span constructor)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Llm,
    Embedding,
    Tool,
    Agent,
    Chain,
}

/// Per-backend span-kind alias attributes for `kind`.
pub(crate) fn span_kind(kind: Kind) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        let v = match kind {
            Kind::Llm => "LLM",
            Kind::Embedding => "EMBEDDING",
            Kind::Tool => "TOOL",
            Kind::Agent => "AGENT",
            Kind::Chain => "CHAIN",
        };
        kvs.push(KeyValue::new("openinference.span.kind", v));
    }
    if set.has(CompatSet::TRACELOOP) {
        let v = match kind {
            Kind::Llm | Kind::Embedding => "task",
            Kind::Tool => "tool",
            Kind::Agent => "agent",
            Kind::Chain => "workflow",
        };
        kvs.push(KeyValue::new("traceloop.span.kind", v));
    }
    if set.has(CompatSet::LANGSMITH) {
        let v = match kind {
            Kind::Llm => "llm",
            Kind::Embedding => "embedding",
            Kind::Tool => "tool",
            Kind::Agent | Kind::Chain => "chain",
        };
        kvs.push(KeyValue::new("langsmith.span.kind", v));
    }
    if set.has(CompatSet::LANGFUSE) {
        let v = match kind {
            Kind::Llm | Kind::Embedding => "generation",
            _ => "span",
        };
        kvs.push(KeyValue::new("langfuse.observation.type", v));
    }
    kvs
}

// ---------------------------------------------------------------------------
// LLM dispatch: provider + model
// ---------------------------------------------------------------------------

/// `op` is the operation ("chat"/"embeddings"); `raw_provider` is the unmapped Sema
/// provider name; `request_model` the resolved request model.
pub(crate) fn llm_dispatch(op: &str, raw_provider: &str, request_model: &str) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() || raw_provider.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        if !request_model.is_empty() {
            kvs.push(KeyValue::new("llm.model_name", request_model.to_string()));
        }
        kvs.push(KeyValue::new(
            "llm.provider",
            openinference_provider(raw_provider).to_string(),
        ));
        if let Some(sys) = openinference_system(raw_provider) {
            kvs.push(KeyValue::new("llm.system", sys.to_string()));
        }
    }
    if set.has(CompatSet::TRACELOOP) {
        kvs.push(KeyValue::new(
            "llm.request.type",
            if op == "embeddings" {
                "embedding"
            } else {
                "chat"
            },
        ));
        if !request_model.is_empty() {
            kvs.push(KeyValue::new(
                "traceloop.entity.name",
                request_model.to_string(),
            ));
        }
    }
    if set.has(CompatSet::LANGSMITH) {
        // LangSmith classifies provider for cost via gen_ai.system (lowercase id).
        kvs.push(KeyValue::new("gen_ai.system", raw_provider.to_string()));
    }
    if set.has(CompatSet::LANGFUSE) && !request_model.is_empty() {
        kvs.push(KeyValue::new(
            "langfuse.observation.model.name",
            request_model.to_string(),
        ));
    }
    kvs
}

// ---------------------------------------------------------------------------
// LLM usage: tokens + cost
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub(crate) fn llm_usage(
    input: u32,
    output: u32,
    total: u32,
    cache_read: u32,
    cache_creation: u32,
    cost: Option<f64>,
) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        kvs.push(KeyValue::new("llm.token_count.prompt", input as i64));
        kvs.push(KeyValue::new("llm.token_count.completion", output as i64));
        kvs.push(KeyValue::new("llm.token_count.total", total as i64));
        if cache_read > 0 {
            kvs.push(KeyValue::new(
                "llm.token_count.prompt_details.cache_read",
                cache_read as i64,
            ));
        }
        if cache_creation > 0 {
            kvs.push(KeyValue::new(
                "llm.token_count.prompt_details.cache_write",
                cache_creation as i64,
            ));
        }
        if let Some(c) = cost {
            kvs.push(KeyValue::new("llm.cost.total", c));
        }
    }
    if set.has(CompatSet::TRACELOOP) {
        kvs.push(KeyValue::new("llm.usage.total_tokens", total as i64));
        kvs.push(KeyValue::new("gen_ai.usage.prompt_tokens", input as i64));
        kvs.push(KeyValue::new(
            "gen_ai.usage.completion_tokens",
            output as i64,
        ));
        if cache_read > 0 {
            kvs.push(KeyValue::new(
                "gen_ai.usage.cache_read_input_tokens",
                cache_read as i64,
            ));
        }
        if cache_creation > 0 {
            kvs.push(KeyValue::new(
                "gen_ai.usage.cache_creation_input_tokens",
                cache_creation as i64,
            ));
        }
    }
    if set.has(CompatSet::LANGFUSE) {
        // Langfuse native usage_details + cost_details JSON objects.
        let usage = serde_json::json!({
            "input": input, "output": output, "total": total,
            "input_cached": cache_read,
        });
        kvs.push(KeyValue::new(
            "langfuse.observation.usage_details",
            usage.to_string(),
        ));
        if let Some(c) = cost {
            kvs.push(KeyValue::new(
                "langfuse.observation.cost_details",
                serde_json::json!({ "total": c }).to_string(),
            ));
        }
    }
    if set.has(CompatSet::BRAINTRUST) {
        if let Some(c) = cost {
            kvs.push(KeyValue::new(
                "braintrust.metrics",
                serde_json::json!({ "cost": c }).to_string(),
            ));
        }
    }
    kvs
}

// ---------------------------------------------------------------------------
// Request parameters (consolidated)
// ---------------------------------------------------------------------------

pub(crate) fn request_params(
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    stop: &[String],
    reasoning_effort: Option<&str>,
) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() || !(set.has(CompatSet::OPENINFERENCE) || set.has(CompatSet::LANGFUSE)) {
        return Vec::new();
    }
    let mut obj = serde_json::Map::new();
    if let Some(t) = temperature {
        obj.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(m) = max_tokens {
        obj.insert("max_tokens".into(), serde_json::json!(m));
    }
    if !stop.is_empty() {
        obj.insert("stop".into(), serde_json::json!(stop));
    }
    if let Some(r) = reasoning_effort {
        obj.insert("reasoning_effort".into(), serde_json::json!(r));
    }
    if obj.is_empty() {
        return Vec::new();
    }
    let json = serde_json::Value::Object(obj).to_string();
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        kvs.push(KeyValue::new("llm.invocation_parameters", json.clone()));
    }
    if set.has(CompatSet::LANGFUSE) {
        kvs.push(KeyValue::new("langfuse.observation.model.parameters", json));
    }
    kvs
}

// ---------------------------------------------------------------------------
// I/O content (already gated by capture_content() at the call site)
// ---------------------------------------------------------------------------

/// `input`/`output` are the structured-message JSON blobs Sema already builds.
pub(crate) fn io(input: &str, output: &str) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        kvs.push(KeyValue::new("input.value", input.to_string()));
        kvs.push(KeyValue::new("output.value", output.to_string()));
        kvs.push(KeyValue::new("input.mime_type", "application/json"));
        kvs.push(KeyValue::new("output.mime_type", "application/json"));
    }
    if set.has(CompatSet::TRACELOOP) {
        kvs.push(KeyValue::new("traceloop.entity.input", input.to_string()));
        kvs.push(KeyValue::new("traceloop.entity.output", output.to_string()));
    }
    if set.has(CompatSet::BRAINTRUST) {
        kvs.push(KeyValue::new("braintrust.input_json", input.to_string()));
        kvs.push(KeyValue::new("braintrust.output_json", output.to_string()));
    }
    kvs
}

/// String-array attribute helper (tags).
fn string_array(key: &'static str, vals: &[String]) -> KeyValue {
    let arr: Vec<StringValue> = vals.iter().map(|s| s.clone().into()).collect();
    KeyValue::new(key, Value::Array(Array::String(arr)))
}

// ---------------------------------------------------------------------------
// Tool execution I/O (on the execute_tool span, content-gated by the caller)
// ---------------------------------------------------------------------------

pub(crate) fn tool_io(args_json: &str, result: &str) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::OPENINFERENCE) {
        // OpenInference has no tool-RESULT key — the result goes in output.value.
        kvs.push(KeyValue::new(
            "tool_call.function.arguments",
            args_json.to_string(),
        ));
        kvs.push(KeyValue::new("input.value", args_json.to_string()));
        kvs.push(KeyValue::new("input.mime_type", "application/json"));
        kvs.push(KeyValue::new("output.value", result.to_string()));
        kvs.push(KeyValue::new("output.mime_type", "text/plain"));
    }
    if set.has(CompatSet::TRACELOOP) {
        kvs.push(KeyValue::new(
            "traceloop.entity.input",
            args_json.to_string(),
        ));
        kvs.push(KeyValue::new("traceloop.entity.output", result.to_string()));
    }
    if set.has(CompatSet::LANGFUSE) {
        kvs.push(KeyValue::new(
            "langfuse.observation.input",
            args_json.to_string(),
        ));
        kvs.push(KeyValue::new(
            "langfuse.observation.output",
            result.to_string(),
        ));
    }
    if set.has(CompatSet::BRAINTRUST) {
        kvs.push(KeyValue::new(
            "braintrust.input_json",
            args_json.to_string(),
        ));
        kvs.push(KeyValue::new("braintrust.output_json", result.to_string()));
    }
    kvs
}

// ---------------------------------------------------------------------------
// Advertised tool schemas (on the chat/LLM span)
// ---------------------------------------------------------------------------

pub(crate) fn tools(views: &[crate::ToolView]) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() || views.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    for (i, t) in views.iter().enumerate() {
        if set.has(CompatSet::OPENINFERENCE) {
            kvs.push(KeyValue::new(
                format!("llm.tools.{i}.tool.json_schema"),
                t.json_schema.clone(),
            ));
        }
        if set.has(CompatSet::TRACELOOP) {
            kvs.push(KeyValue::new(
                format!("llm.request.functions.{i}.name"),
                t.name.clone(),
            ));
            kvs.push(KeyValue::new(
                format!("llm.request.functions.{i}.description"),
                t.description.clone(),
            ));
            kvs.push(KeyValue::new(
                format!("llm.request.functions.{i}.parameters"),
                t.json_schema.clone(),
            ));
        }
    }
    kvs
}

// ---------------------------------------------------------------------------
// Trace-level I/O rollup (on the run's ROOT span — agent, or standalone chat)
// ---------------------------------------------------------------------------

pub(crate) fn trace_io(input: &str, output: &str) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::LANGFUSE) {
        kvs.push(KeyValue::new("langfuse.trace.input", input.to_string()));
        kvs.push(KeyValue::new("langfuse.trace.output", output.to_string()));
    }
    kvs
}

// ---------------------------------------------------------------------------
// Tags + metadata
// ---------------------------------------------------------------------------

pub(crate) fn tags(tags: &[String]) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() || tags.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    if set.has(CompatSet::LANGFUSE) {
        kvs.push(string_array("langfuse.trace.tags", tags));
    }
    if set.has(CompatSet::BRAINTRUST) {
        kvs.push(string_array("braintrust.tags", tags));
    }
    if set.has(CompatSet::LANGSMITH) {
        kvs.push(KeyValue::new("langsmith.span.tags", tags.join(",")));
    }
    kvs
}

pub(crate) fn metadata(meta: &[(String, String)]) -> Vec<KeyValue> {
    let set = active();
    if set.is_empty() || meta.is_empty() {
        return Vec::new();
    }
    let mut kvs = Vec::new();
    for (k, v) in meta {
        if set.has(CompatSet::LANGFUSE) {
            kvs.push(KeyValue::new(
                format!("langfuse.trace.metadata.{k}"),
                v.clone(),
            ));
        }
        if set.has(CompatSet::LANGSMITH) {
            kvs.push(KeyValue::new(format!("langsmith.metadata.{k}"), v.clone()));
        }
        if set.has(CompatSet::TRACELOOP) {
            kvs.push(KeyValue::new(
                format!("traceloop.association.properties.{k}"),
                v.clone(),
            ));
        }
    }
    if set.has(CompatSet::BRAINTRUST) {
        let obj: serde_json::Map<String, serde_json::Value> = meta
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        kvs.push(KeyValue::new(
            "braintrust.metadata",
            serde_json::Value::Object(obj).to_string(),
        ));
    }
    kvs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tokens_case_and_aliases() {
        assert_eq!(parse(""), 0);
        assert_eq!(parse("openinference"), CompatSet::OPENINFERENCE);
        assert_eq!(parse("Phoenix"), CompatSet::OPENINFERENCE);
        assert_eq!(
            parse("arize, langsmith"),
            CompatSet::OPENINFERENCE | CompatSet::LANGSMITH
        );
        assert_eq!(parse("openllmetry"), CompatSet::TRACELOOP);
        assert_eq!(parse("all"), CompatSet::ALL);
        assert_eq!(parse("bogus"), 0); // unknown ignored
    }

    #[test]
    fn provider_back_translation() {
        assert_eq!(openinference_provider("gemini"), "google");
        assert_eq!(openinference_provider("mistral"), "mistralai");
        assert_eq!(openinference_provider("ollama"), "ollama");
        assert_eq!(openinference_system("gemini"), Some("vertexai"));
        assert_eq!(openinference_system("ollama"), None);
    }
}
