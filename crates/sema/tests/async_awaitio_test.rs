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
use serial_test::serial;

/// Five `(llm/io-sleep-once i 1000)` run as five tasks via
/// `async/all` + `async/spawn` + `map`. Overlap means ~1 s, not ~5 s.
///
/// `#[serial]`: every test in this file resets and reads the *process-global*
/// `IO_INFLIGHT`/`IO_PEAK` instrumentation atomics, so they must not run
/// concurrently or one test's `reset_io_inflight()` clobbers another's peak
/// measurement.
#[test]
#[serial]
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

/// Adversarial repro (#2): a short `async/sleep` sleeper must NOT be starved by a
/// long in-flight `AwaitIo` future. With the buggy `io_park(50); continue;`
/// short-circuit the virtual clock never advances while IO is pending, so a
/// 200 ms sleeper does not wake until the 1500 ms IO finishes (~1700 ms total,
/// serialized). The sleeper instruments its own wake time via `sys/elapsed` and
/// returns the elapsed-ms-since-start; it must wake at ~200 ms, not ~1700 ms.
#[test]
#[serial]
fn sleeper_not_starved_by_inflight_io() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    // t0 captured at program start (ns). The sleeper sleeps 200 ms then records
    // how long it actually slept (wall-clock ms since t0). The IO task runs a
    // 1500 ms offloaded future in parallel. `async/all` returns
    // (sleeper-wake-ms io-id).
    let program = r#"
        (let ((t0 (sys/elapsed)))
          (async/all
            (list
              (async/spawn (fn ()
                (async/sleep 200)
                (floor (/ (- (sys/elapsed) t0) 1000000))))
              (async/spawn (fn ()
                (llm/io-sleep-once 0 1500))))))
    "#;

    let result = interp
        .eval_str_compiled(program)
        .expect("sleeper/io program evaluated");

    let items = result.as_list().expect("async/all returns a list");
    assert_eq!(items.len(), 2, "expected two results");
    let sleeper_wake_ms = items[0].as_int().expect("sleeper wake ms is an int");

    // The sleeper must wake at ~200 ms (it requested a 200 ms sleep), NOT be
    // dragged to ~1700 ms by the in-flight 1500 ms IO. A generous ceiling of
    // 600 ms passes for the fixed behavior and fails for the ~1700 ms bug.
    assert!(
        sleeper_wake_ms < 600,
        "sleeper starved by in-flight IO: woke at {sleeper_wake_ms} ms (expected ~200 ms, < 600 ms)"
    );
    assert!(
        sleeper_wake_ms >= 150,
        "sleeper woke too early: {sleeper_wake_ms} ms (expected ~200 ms)"
    );
}

/// Adversarial repro (#3): `async/timeout` must fire while an `AwaitIo` future is
/// in flight. The buggy short-circuit skips the `goal.sleep_limit()` timeout
/// check, so a 300 ms timeout over a 2000 ms IO does not fire until the IO
/// finishes (~2000 ms). The control over `async/sleep` DOES time out at ~300 ms,
/// so the bug is AwaitIo-specific.
#[test]
#[serial]
fn timeout_fires_over_inflight_io() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();

    // (a) Negative: 300 ms timeout over a 2000 ms in-flight IO must time out
    //     (async/timeout returns an Err on expiry) at ~300 ms, not ~2000 ms.
    let timeout_program = r#"
        (let ((p (async/spawn (fn () (llm/io-sleep-once 0 2000)))))
          (async/timeout 300 p))
    "#;
    let t0 = Instant::now();
    let err = interp
        .eval_str_compiled(timeout_program)
        .expect_err("expected async/timeout to fire (error) over in-flight IO");
    let timeout_ms = t0.elapsed().as_millis();
    assert!(
        err.to_string().contains("timed out"),
        "expected a timeout error, got: {err}"
    );
    assert!(
        timeout_ms < 700,
        "async/timeout did not fire over in-flight IO: took {timeout_ms} ms (expected ~300 ms, < 700 ms)"
    );
    assert!(
        timeout_ms >= 250,
        "async/timeout fired too early: {timeout_ms} ms (expected ~300 ms)"
    );

    // (b) Positive: a 2000 ms timeout over a 500 ms IO returns the value at
    //     ~500 ms (no spurious timeout, overlap preserved).
    sema_llm::builtins::reset_io_inflight();
    let ok_program = r#"
        (let ((p (async/spawn (fn () (llm/io-sleep-once 7 500)))))
          (async/timeout 2000 p))
    "#;
    let t1 = Instant::now();
    let val = interp
        .eval_str_compiled(ok_program)
        .expect("expected the IO value within the timeout window");
    let ok_ms = t1.elapsed().as_millis();
    assert_eq!(val, Value::int(7), "expected the resolved IO id (7)");
    assert!(
        ok_ms < 1200,
        "positive timeout case took too long: {ok_ms} ms (expected ~500 ms)"
    );
}
