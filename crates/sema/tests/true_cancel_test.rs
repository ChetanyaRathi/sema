//! Acceptance gate for Slice B — TRUE cancellation (real socket/process abort).
//!
//! When an `async/timeout` (or `async/cancel`) abandons a task parked on an
//! offloaded `AwaitIo` future, the scheduler now runs the handle's abort hook. For
//! the `spawn`-based subprocess offload that means the in-flight future is aborted
//! and, because the `tokio::process::Command` is `kill_on_drop(true)`, the child
//! process is KILLED — not left running to completion. These tests prove the kill
//! deterministically via a marker file the subprocess only writes if it survives.
//!
//! (The http abort tier uses the same seam — `AbortHandle::abort()` drops the
//! reqwest future — but asserting a torn-down socket needs a live server, so it is
//! covered by the unit tests on `IoHandle` + this subprocess gate rather than a
//! networked test here.)

#![cfg(not(target_arch = "wasm32"))]

use sema_eval::Interpreter;
use serial_test::serial;
use std::path::PathBuf;
use std::time::Duration;

/// A unique marker path under the system temp dir for one test (removed up front).
fn marker(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "sema_true_cancel_{}_{}.marker",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

/// HEADLINE GATE: a subprocess that sleeps then writes a marker, abandoned by a
/// short `async/timeout`, must be KILLED — the marker must NOT appear even after we
/// wait well past the subprocess's own sleep. A best-effort cancel (the old
/// behavior) would let the child run to completion and the marker WOULD appear.
#[test]
#[serial]
fn subprocess_is_killed_on_timeout() {
    let m = marker("killed");
    let interp = Interpreter::new();
    let program = format!(
        r#"(try
             (async/timeout 200
               (async/spawn (fn () (shell "sh" "-c" "sleep 3; touch {}"))))
             (catch e :caught))"#,
        m.display()
    );
    let result = interp
        .eval_str_compiled(&program)
        .expect("timeout-abandoned shell evaluated");
    assert_eq!(
        result,
        sema_core::Value::keyword("caught"),
        "the timeout must surface as a caught error"
    );
    // Wait past the subprocess's 3 s sleep. If it was merely abandoned (not killed),
    // it would `touch` the marker around now. A real kill means it never does.
    std::thread::sleep(Duration::from_millis(4000));
    assert!(
        !m.exists(),
        "the subprocess must have been KILLED on timeout — marker {} should not exist",
        m.display()
    );
    let _ = std::fs::remove_file(&m);
}

/// CONTROL: with a timeout LONGER than the subprocess's work, it completes normally
/// and the marker IS written — proving the kill gate above isn't a false positive
/// (e.g. the shell never running at all).
#[test]
#[serial]
fn subprocess_completes_when_timeout_is_longer() {
    let m = marker("completes");
    let interp = Interpreter::new();
    let program = format!(
        r#"(async/timeout 5000
             (async/spawn (fn () (shell "sh" "-c" "sleep 1; touch {}"))))"#,
        m.display()
    );
    interp
        .eval_str_compiled(&program)
        .expect("long-timeout shell evaluated");
    // The shell ran to completion within the timeout, so the marker exists now.
    assert!(
        m.exists(),
        "the subprocess should have completed and written marker {}",
        m.display()
    );
    let _ = std::fs::remove_file(&m);
}

/// A normally-completing concurrent subprocess must return its real output and must
/// NOT be aborted (the abort hook fires only on cancel/timeout/interrupt).
#[test]
#[serial]
fn normal_completion_returns_output_and_is_not_aborted() {
    let interp = Interpreter::new();
    let program = r#"
        (let ((r (async/await (async/spawn (fn () (shell "sh" "-c" "echo hello"))))))
          (string/trim (:stdout r)))
    "#;
    let result = interp
        .eval_str_compiled(program)
        .expect("normal concurrent shell evaluated");
    assert_eq!(
        result,
        sema_core::Value::string("hello"),
        "a normally-completing shell must return its stdout, never be aborted"
    );
}
