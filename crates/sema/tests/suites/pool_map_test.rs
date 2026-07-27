//! Acceptance gate for `async/pool-map` — bounded-concurrency fan-out.
//!
//! `(async/all (map #(async/spawn …) items))` opens ALL tasks at once; with the
//! `AwaitIo` mechanism that means N sockets/processes in flight. `async/pool-map`
//! caps concurrency at `n` while preserving INPUT order. These tests use the
//! `llm/io-sleep-once <id> <ms>` spike leaf plus its `io_peak_inflight()` /
//! `reset_io_inflight()` instrumentation to prove the cap actually held (not just
//! a plausible wall-clock).
//!
//! `#[serial]`: every test resets and reads the *process-global*
//! `IO_INFLIGHT`/`IO_PEAK` atomics, so they must not run concurrently.

#![cfg(not(target_arch = "wasm32"))]

use std::time::Instant;

use sema_core::Value;
use sema_eval::Interpreter;
use serial_test::serial;

/// Bounded concurrency: six 200 ms sleeps through a pool of 2 must run in
/// ceil(6/2)=3 batches (~600 ms), the peak in-flight must be <= 2 (the cap held),
/// and results must come back in input order 0..5.
#[test]
#[serial]
fn pool_map_caps_concurrency_at_two() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    let program = r#"
        (async/pool-map (fn (i) (llm/io-sleep-once i 200)) '(0 1 2 3 4 5) 2)
    "#;

    let t0 = Instant::now();
    let result = interp
        .eval_str_compiled(program)
        .expect("pool-map program evaluated");
    let elapsed_ms = t0.elapsed().as_millis();

    // (1) Order preserved: ids 0..=5 in input order.
    assert_eq!(
        result,
        Value::list((0..6).map(Value::int).collect()),
        "expected six resolved ids 0..5 in INPUT order"
    );

    // (2) The cap held: at most 2 futures in flight at any instant.
    let peak = sema_llm::builtins::io_peak_inflight();
    assert!(
        peak <= 2,
        "pool cap breached: peak in-flight {peak} (expected <= 2)"
    );

    // (3) Timing: ~3 batches × 200 ms = ~600 ms. Decisively below the
    // ~1200 ms a too-small pool would give, and above the ~200 ms
    // all-at-once floor. Assert the [500, 1000] ms window AND peak <= 2.
    assert!(
        (500..=1000).contains(&elapsed_ms),
        "expected ~600 ms (3 batches), got {elapsed_ms} ms (peak {peak})"
    );
}

/// `n >= len`: a pool of 10 over 5 items behaves like full fan-out — peak rises
/// to 5 (all run at once) and wall-clock is ~200 ms (one batch).
#[test]
#[serial]
fn pool_map_n_ge_len_is_full_fanout() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    let program = r#"
        (async/pool-map (fn (i) (llm/io-sleep-once i 200)) '(0 1 2 3 4) 10)
    "#;

    let t0 = Instant::now();
    let result = interp
        .eval_str_compiled(program)
        .expect("pool-map program evaluated");
    let elapsed_ms = t0.elapsed().as_millis();

    assert_eq!(
        result,
        Value::list((0..5).map(Value::int).collect()),
        "expected five resolved ids 0..4 in input order"
    );

    // Full fan-out: all five overlap (peak up to 5), one ~200 ms batch.
    let peak = sema_llm::builtins::io_peak_inflight();
    assert!(
        peak >= 2,
        "expected real overlap with n >= len, peak {peak}"
    );
    assert!(peak <= 5, "peak {peak} exceeds item count (5) — impossible");
    assert!(
        elapsed_ms < 500,
        "expected ~200 ms (single batch), got {elapsed_ms} ms"
    );
}

/// Error releases its token (no deadlock): an `f` that throws on one item must
/// still let the pool drain and surface the error promptly — NOT hang. If the
/// token were leaked on the error path, the pool would deadlock and this would
/// never return.
#[test]
#[serial]
fn pool_map_error_releases_token_no_deadlock() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    // Pool of 2: item 3 throws after its sleep; the rest sleep normally. A leaked
    // token on the error path would starve the pool and wedge here.
    let program = r#"
        (try
          (async/pool-map
            (fn (i)
              (llm/io-sleep-once i 100)
              (if (= i 3) (throw "boom") i))
            '(0 1 2 3 4 5) 2)
          (catch e "caught"))
    "#;

    let t0 = Instant::now();
    let result = interp
        .eval_str_compiled(program)
        .expect("pool-map error program evaluated (did not deadlock)");
    let elapsed_ms = t0.elapsed().as_millis();

    assert_eq!(
        result,
        Value::string("caught"),
        "expected the thrown error to surface and be caught"
    );
    // Whatever the exact failure timing, it must terminate promptly — a deadlock
    // would blow past any sane ceiling (or hang forever under the test harness).
    assert!(
        elapsed_ms < 2000,
        "pool wedged on error path: took {elapsed_ms} ms (expected prompt failure)"
    );
}

/// Order preserved under nondeterministic completion: reversed sleeps (item 0
/// sleeps longest, item 5 shortest) finish out of order, but `async/pool-map`
/// must still return results in INPUT order 0..5.
#[test]
#[serial]
fn pool_map_preserves_order_under_reversed_completion() {
    sema_llm::builtins::reset_io_inflight();

    let interp = Interpreter::new();
    // sleep = (6 - i) * 50: i=0 -> 300 ms, i=5 -> 50 ms. Completion order is the
    // reverse of input order; the result must still be 0..5.
    let program = r#"
        (async/pool-map (fn (i) (llm/io-sleep-once i (* (- 6 i) 50))) '(0 1 2 3 4 5) 3)
    "#;

    let result = interp
        .eval_str_compiled(program)
        .expect("pool-map reversed-completion program evaluated");

    assert_eq!(
        result,
        Value::list((0..6).map(Value::int).collect()),
        "expected input order 0..5 despite reversed completion"
    );
}
