//! Gap-3: `TelemetryMode::OwnProvider` emits against a host-supplied provider WITHOUT
//! installing a global one. Own binary (global provider is process-global).

#![cfg(not(target_arch = "wasm32"))]

use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use sema::InterpreterBuilder;
use sema_otel::TelemetryMode;

#[test]
fn own_provider_routes_without_installing_global() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();

    let interp = InterpreterBuilder::new()
        .with_telemetry(TelemetryMode::OwnProvider(provider))
        .build();

    // OwnProvider must NOT install a global provider.
    assert!(
        !sema_otel::host_global_is_real(),
        "OwnProvider must not call set_tracer_provider"
    );

    interp
        .eval_str(r#"(otel/span "owned-work" (fn () (+ 1 2)))"#)
        .expect("otel/span should run");

    let spans = exporter
        .get_finished_spans()
        .expect("in-memory spans readable");
    assert!(
        spans.iter().any(|s| s.name == "owned-work"),
        "the Sema span should land in the host-supplied provider"
    );
}
