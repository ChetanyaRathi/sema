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

/// HEADLINE GATE: the marker is written by a GRANDCHILD (a backgrounded subshell)
/// that `sh` forks, while `sh` itself stays alive (`wait`). On timeout the whole
/// PROCESS GROUP must be killed — so neither `sh` nor the grandchild survives and
/// the marker never appears. This specifically distinguishes a group kill from a
/// kill of only the direct `sh` pid (which would orphan the grandchild, leaving it
/// to `touch` the marker after its sleep).
#[test]
#[serial]
fn subprocess_group_is_killed_on_timeout() {
    let m = marker("killed");
    let interp = Interpreter::new();
    let program = format!(
        r#"(try
             (async/timeout 200
               (async/spawn (fn () (shell "sh" "-c" "(sleep 3; touch {}) & wait"))))
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
    // Wait past the grandchild's 3 s sleep. If only `sh` (the direct child) were
    // killed, the orphaned grandchild would `touch` the marker around now.
    std::thread::sleep(Duration::from_millis(4000));
    assert!(
        !m.exists(),
        "the whole process GROUP must be killed on timeout — marker {} should not exist",
        m.display()
    );
    let _ = std::fs::remove_file(&m);
}

/// Cancellation must be TRANSITIVE: a subprocess awaited INDIRECTLY (one
/// `async/await` layer deeper than the timed-out task) must still be killed, and its
/// inner task must not survive as an un-reaped orphan. Before transitive cancel, the
/// timeout cancelled only the outer task and the inner `Blocked(AwaitIo)` shell task
/// ran to completion (marker appeared) AND lingered in the scheduler.
#[test]
#[serial]
fn indirectly_awaited_subprocess_is_killed_on_timeout() {
    let m = marker("indirect");
    let interp = Interpreter::new();
    let program = format!(
        r#"(try
             (async/timeout 200
               (async/spawn (fn ()
                 (async/await
                   (async/spawn (fn () (shell "sh" "-c" "(sleep 3; touch {}) & wait")))))))
             (catch e :caught))"#,
        m.display()
    );
    let result = interp
        .eval_str_compiled(&program)
        .expect("indirect timeout-abandoned shell evaluated");
    assert_eq!(result, sema_core::Value::keyword("caught"));
    // No orphaned inner task left behind (would also be a #7 span-at-teardown hazard
    // for the LLM tier): transitive cancel transitioned it to terminal → reaped.
    assert_eq!(
        sema_vm::scheduler_task_count(),
        0,
        "the indirectly-awaited inner task must be cancelled + reaped, not orphaned"
    );
    std::thread::sleep(Duration::from_millis(4000));
    assert!(
        !m.exists(),
        "an indirectly-awaited subprocess must also be killed — marker {} should not exist",
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
