//! Deterministic in-process span capture for tests (behind the `testing` feature).
//!
//! Installs an in-memory exporter as the global provider and enables the facade, so a
//! downstream crate can run real Sema/LLM code and assert on the emitted spans as
//! plain JSON — no network, no collector, no OTel types in the test.

use opentelemetry::global;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};

use crate::file_exporter::span_to_json;

/// A handle to in-memory captured spans. Created by [`install`].
pub struct SpanCapture {
    exporter: InMemorySpanExporter,
    provider: SdkTracerProvider,
}

/// Install an in-memory span exporter as the global provider and enable the facade.
///
/// Call ONCE per test process (`global::set_tracer_provider` is process-global). Put
/// the test in its own integration-test file so it gets a fresh process.
pub fn install() -> SpanCapture {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    global::set_tracer_provider(provider.clone());
    // Force the facade on (it would otherwise only enable via init_from_env).
    super::use_host_global();
    SpanCapture { exporter, provider }
}

impl SpanCapture {
    /// All finished spans so far, serialized to the Sema JSONL schema (one object per
    /// span). Flushes first so freshly-ended spans are visible.
    pub fn spans_json(&self) -> Vec<serde_json::Value> {
        let _ = self.provider.force_flush();
        self.exporter
            .get_finished_spans()
            .unwrap_or_default()
            .iter()
            .map(span_to_json)
            .collect()
    }

    /// Find the first captured span with the given `name`.
    pub fn span_named(&self, name: &str) -> Option<serde_json::Value> {
        self.spans_json().into_iter().find(|s| s["name"] == name)
    }
}
