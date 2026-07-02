//! M0 fail-safe (§3.3h): a span-emitting run against a DOWN collector
//! (`127.0.0.1:1`) must still complete quickly and exit cleanly — proving the
//! down-collector-never-blocks invariant. Single test in its own binary.

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn down_collector_never_blocks() {
    use std::time::{Duration, Instant};

    // SAFETY: single-threaded test setup before any otel init.
    unsafe {
        std::env::remove_var("SEMA_OTEL_FILE");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1");
        std::env::set_var("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
        // Keep the exporter timeout short so a dead endpoint releases its slot fast.
        std::env::set_var("OTEL_EXPORTER_OTLP_TIMEOUT", "1000");
    }

    let start = Instant::now();
    let guard = sema_otel::init_from_env();
    assert!(guard.is_some(), "an OTLP endpoint must install a provider");

    // Emit a batch of spans aimed at the dead collector.
    for i in 0..50 {
        let s = sema_otel::llm_span("chat");
        s.set_dispatch("openai", "gpt-x");
        s.set_response(&sema_otel::ResponseFacts {
            input_tokens: i,
            output_tokens: i,
            ..Default::default()
        });
        drop(s);
    }

    // Drop the guard → bounded flush + shutdown_with_timeout(3s). Must not hang.
    drop(guard);

    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(10),
        "down collector blocked the run for {elapsed:?} — fail-safe violated"
    );
}
