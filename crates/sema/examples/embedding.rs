//! Embedding Sema in a Rust application.
//!
//! Run with:
//!
//! ```sh
//! cargo run -p sema-lang --example embedding
//! ```
//!
//! This walks through the full embedding surface of the `sema` crate:
//!   1. A default interpreter and basic evaluation.
//!   2. Persistent top-level definitions across `eval_str` calls.
//!   3. Prelude macros (e.g. the threading macro `->`).
//!   4. Registering a Rust function callable from Sema (`register_fn`).
//!   5. Pre-loading a module and importing it, with export restriction.
//!   6. Async / `await` (the bytecode VM is the sole evaluator).
//!   7. Customising the interpreter via the builder (stdlib/LLM toggles, sandbox).
//!   8. Reading values back out and handling errors.
//!
//! Everything here runs on the bytecode VM — Sema's sole evaluator.

use sema::{Interpreter, SemaError, Value};

fn main() {
    // 1. Default interpreter (stdlib + LLM builtins enabled).
    let interp = Interpreter::new();
    let v = interp.eval_str("(+ 1 2 3)").expect("arithmetic");
    println!("1. (+ 1 2 3) => {v}");

    // 2. Definitions persist across calls — the global env is shared.
    interp
        .eval_str("(define (square x) (* x x))")
        .expect("define");
    let v = interp.eval_str("(square 9)").expect("call square");
    println!("2. (square 9) => {v}");

    // 3. Prelude macros are available to embedders.
    let v = interp.eval_str("(-> 5 (+ 3) (* 2))").expect("threading");
    println!("3. (-> 5 (+ 3) (* 2)) => {v}");

    // 4. Expose a Rust function to Sema code.
    interp.register_fn("rust-hypot", |args: &[Value]| {
        let a = args[0]
            .as_int()
            .ok_or_else(|| SemaError::type_error("integer", args[0].type_name()))?;
        let b = args[1]
            .as_int()
            .ok_or_else(|| SemaError::type_error("integer", args[1].type_name()))?;
        Ok(Value::int(a * a + b * b))
    });
    let v = interp
        .eval_str("(rust-hypot 3 4)")
        .expect("call rust-hypot");
    println!("4. (rust-hypot 3 4) => {v}");

    // 5. Pre-load a module; only exported bindings are visible after import.
    interp
        .preload_module(
            "geometry",
            r#"(module geometry (export area)
                 (define scale 3)           ; not exported
                 (define (area r) (* scale r r)))"#,
        )
        .expect("preload module");
    interp.eval_str(r#"(import "geometry")"#).expect("import");
    let v = interp.eval_str("(area 10)").expect("call area");
    println!(
        "5. (area 10) => {v}   (private `scale` stays hidden: {})",
        { interp.eval_str("scale").is_err() }
    );

    // 6. Async / await runs on the VM.
    let v = interp.eval_str("(await (async (+ 40 2)))").expect("async");
    println!("6. (await (async (+ 40 2))) => {v}");

    // 7. Builder: a locked-down interpreter with no LLM builtins.
    let sandboxed = Interpreter::builder().without_llm().build();
    let v = sandboxed
        .eval_str("(string-upcase \"hello\")")
        .expect("stdlib still works");
    println!("7. sandboxed (string-upcase \"hello\") => {v}");

    // 8. Error handling: eval_str returns a Result you can match on.
    match interp.eval_str("(this-is-not-defined)") {
        Ok(_) => println!("8. unexpected success"),
        Err(e) => println!("8. unbound call surfaced as error: {e}"),
    }

    println!("\nAll embedding scenarios ran on the bytecode VM.");
}
