//! Tests for the public embedding API (`sema::Interpreter`), which wraps
//! `sema_eval::Interpreter`. Regression guard for M6: the builder must register
//! the VM delegates + prelude so embedders get import/load and prelude macros on
//! the VM (the sole evaluator), and `preload_module` must run on the VM.

use sema::{Interpreter, Value};

#[test]
fn embedding_prelude_macros_work() {
    let interp = Interpreter::new();
    // Threading macro from the prelude must be available to embedders.
    assert_eq!(
        interp.eval_str("(-> 5 (+ 3) (* 2))").unwrap(),
        Value::int(16)
    );
}

#[test]
fn embedding_defines_persist_across_calls() {
    let interp = Interpreter::new();
    interp.eval_str("(define (sq x) (* x x))").unwrap();
    assert_eq!(interp.eval_str("(sq 9)").unwrap(), Value::int(81));
}

#[test]
fn embedding_preload_module_export_restriction() {
    let interp = Interpreter::new();
    interp
        .preload_module(
            "math",
            r#"(module math (export square)
                 (define (square x) (* x x))
                 (define internal 42))"#,
        )
        .unwrap();
    interp.eval_str(r#"(import "math")"#).unwrap();
    assert_eq!(interp.eval_str("(square 5)").unwrap(), Value::int(25));
    // The non-exported `internal` must not leak to the importer.
    assert!(
        interp.eval_str("internal").is_err(),
        "non-exported binding `internal` must not be visible after import"
    );
}

#[test]
fn embedding_async_works_on_vm() {
    // Async is VM-only; the embedding API runs on the VM, so this must succeed.
    let interp = Interpreter::new();
    assert_eq!(
        interp.eval_str("(await (async (+ 40 2)))").unwrap(),
        Value::int(42)
    );
}
