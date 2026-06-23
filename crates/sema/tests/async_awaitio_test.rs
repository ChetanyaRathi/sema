//! Acceptance gate for the `AwaitIo` cooperative-yield mechanism (Phase 1).
//!
//! Proves that several `async/spawn`'d tasks each parked on an offloaded I/O
//! future (`llm/io-sleep-once`) overlap on the single VM thread: five 1 s sleeps
//! complete in ~1 s wall-clock (max), not ~5 s (sum), and the peak number of
//! futures in flight simultaneously is >= 2. Network-free and key-free — the
//! spike leaf is a pure timer on the shared tokio runtime.

#![cfg(not(target_arch = "wasm32"))]

use std::time::Instant;

use sema_core::Value;
use sema_eval::Interpreter;

/// Five `(llm/io-sleep-once i 1000)` run as five tasks via
/// `async/all` + `async/spawn` + `map`. Overlap means ~1 s, not ~5 s.
#[test]
fn awaitio_five_one_second_sleeps_overlap() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    let program = r#"
        (async/all
          (map (fn (i) (async/spawn (fn () (llm/io-sleep-once i 1000))))
               (list 0 1 2 3 4)))
    "#;

    let t0 = Instant::now();
    let result = interp
        .eval_str_compiled(program)
        .expect("awaitio program evaluated");
    let elapsed_ms = t0.elapsed().as_millis();

    // (1) Correctness: five results, the ids 0..=4 in order.
    assert_eq!(
        result,
        Value::list((0..5).map(Value::int).collect()),
        "expected five resolved ids 0..4 in spawn order"
    );

    // (2) Overlap (timing): serial floor is ~5000 ms; overlapping ~1000 ms.
    assert!(
        elapsed_ms < 2500,
        "expected overlapped wall-clock < 2500 ms (serial floor ~5000 ms), got {elapsed_ms} ms"
    );

    // (3) In-flight (deterministic): >= 2 futures simultaneously in flight
    // proves true simultaneity, not just a fast wall-clock.
    let peak = sema_llm::builtins::io_peak_inflight();
    assert!(
        peak >= 2,
        "expected peak in-flight >= 2 (true overlap), got {peak}"
    );
}
