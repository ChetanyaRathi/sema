//! Tests for VM-backed `(load ...)`: when the VM is the active backend, a loaded
//! file's body is compiled and run on the bytecode VM (not the tree-walker), so
//! async/channels work in loaded files and the code runs at VM speed.
//!
//! `(import ...)` is intentionally STILL tree-walked even under the VM backend
//! (its module isolation needs lexical env capture the VM does not yet provide —
//! see docs/plans/2026-06-16-vm-module-loading.md). The import tests here assert
//! that isolation stays correct under the VM backend.

use sema_core::Value;
use sema_eval::Interpreter;
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("sema-vmmod-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write(dir: &std::path::Path, name: &str, src: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, src).expect("write module file");
    p.to_string_lossy().to_string()
}

/// Evaluate on the VM backend (sets vm_backend=true → load runs on the VM).
fn vm(input: &str) -> Result<Value, String> {
    Interpreter::new()
        .eval_str_compiled(input)
        .map_err(|e| e.to_string())
}

/// Evaluate on the tree-walker backend.
fn tw(input: &str) -> Result<Value, String> {
    Interpreter::new()
        .eval_str(input)
        .map_err(|e| e.to_string())
}

fn assert_equiv(input: &str) -> Value {
    let v = vm(input).unwrap_or_else(|e| panic!("VM failed for `{input}`: {e}"));
    let t = tw(input).unwrap_or_else(|e| panic!("TW failed for `{input}`: {e}"));
    assert_eq!(v, t, "VM/TW divergence for `{input}`");
    v
}

#[test]
fn vm_load_defines_visible_after() {
    let dir = temp_dir("load-vis");
    let m = write(
        &dir,
        "m.sema",
        "(define loaded-value 42)\n(define (dbl x) (* x 2))",
    );
    let r = vm(&format!(
        r#"(begin (load "{m}") (list loaded-value (dbl 21)))"#
    ))
    .unwrap();
    assert_eq!(r, Value::list(vec![Value::int(42), Value::int(42)]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_load_returns_last_expr() {
    let dir = temp_dir("load-ret");
    let m = write(&dir, "m.sema", "(define a 1)\n(+ a 99)");
    assert_eq!(vm(&format!(r#"(load "{m}")"#)).unwrap(), Value::int(100));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_nested_transitive_load() {
    let dir = temp_dir("load-nested");
    let c = write(&dir, "c.sema", "(define c-val 3)");
    let b = write(
        &dir,
        "b.sema",
        &format!("(load \"{c}\")\n(define b-val (+ c-val 10))"),
    );
    let r = vm(&format!(r#"(begin (load "{b}") (list b-val c-val))"#)).unwrap();
    assert_eq!(r, Value::list(vec![Value::int(13), Value::int(3)]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_macro_defined_and_used_within_loaded_file() {
    // Per-form expand→compile→run: a defmacro is registered before later forms
    // in the same file are compiled, so intra-file macro use works on the VM.
    let dir = temp_dir("load-macro");
    let m = write(
        &dir,
        "macros.sema",
        "(defmacro twice (x) (list (quote begin) x x))\n(define counter 0)\n(twice (set! counter (+ counter 1)))\n(define result counter)",
    );
    assert_eq!(
        vm(&format!(r#"(begin (load "{m}") result)"#)).unwrap(),
        Value::int(2)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_async_in_loaded_module_works() {
    // The motivating capability: async (a VM-only feature) inside a loaded file
    // now works because the body runs on the VM. On the tree-walker it errors.
    let dir = temp_dir("load-async");
    let m = write(
        &dir,
        "amod.sema",
        "(define (compute) (await (async (+ 40 2))))",
    );
    let src = format!(r#"(begin (load "{m}") (compute))"#);
    assert_eq!(vm(&src).unwrap(), Value::int(42));
    assert!(
        tw(&src).is_err(),
        "async in a loaded file should fail on the tree-walker"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_load_redefine_global_invalidates_cache() {
    // Regression: a global redefined inside a loaded file must be observed by the
    // caller afterward (the inner VM runs on a cloned env; load bumps the shared
    // env's version so the outer VM's inline global cache is invalidated).
    let dir = temp_dir("load-cache");
    let m = write(&dir, "redef.sema", "(define shared 999)");
    let r = vm(&format!(
        r#"(begin (define shared 1) (define (peek) shared) (list (peek) (begin (load "{m}") (peek))))"#
    ))
    .unwrap();
    assert_eq!(
        r,
        Value::list(vec![Value::int(1), Value::int(999)]),
        "second peek must see the redefined value, not a stale cached one"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_load_error_propagates_and_recovers() {
    let dir = temp_dir("load-err");
    let bad = write(&dir, "bad.sema", "(+ 1 undefined-symbol-xyz)");
    let good = write(&dir, "good.sema", "(define ok 1)");
    let err = vm(&format!(r#"(load "{bad}")"#)).unwrap_err();
    assert!(
        err.to_lowercase().contains("undefined-symbol-xyz")
            || err.to_lowercase().contains("unbound"),
        "loaded-file error should surface: {err}"
    );
    // A subsequent load on a fresh interpreter still works (stacks balanced).
    assert_eq!(
        vm(&format!(r#"(begin (load "{good}") ok)"#)).unwrap(),
        Value::int(1)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_load_matches_tree_walker() {
    let dir = temp_dir("load-equiv");
    let m = write(&dir, "m.sema", "(define (sq x) (* x x))\n(define base 5)");
    assert_equiv(&format!(r#"(begin (load "{m}") (+ (sq base) base))"#));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_backend_import_keeps_tree_walker_isolation() {
    // import stays tree-walked even under the VM backend, so the ubiquitous
    // "exported fn calls a private helper" pattern works (it would break if
    // import ran on the VM — VM closures carry no per-module globals env).
    let dir = temp_dir("imp-iso");
    let m = write(
        &dir,
        "lib.sema",
        "(define (private-helper x) (* x 10))\n(define (public-api x) (private-helper x))",
    );
    // selective import of only the public fn
    let r = vm(&format!(
        r#"(begin (import "{m}" public-api) (public-api 5))"#
    ))
    .unwrap();
    assert_eq!(r, Value::int(50));
    // private helper must not leak into the importer
    let leaked = vm(&format!(
        r#"(begin (import "{m}" public-api) (private-helper 1))"#
    ));
    assert!(
        leaked.is_err(),
        "private-helper must not leak, got {leaked:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vm_backend_flag_resets_for_single_expr_eval() {
    // Regression for the sticky-flag leak: after a VM eval on an interpreter, a
    // subsequent single-expr tree-walker eval must NOT run a loaded body on the
    // VM. We verify by loading an async-using file via eval_in_global (TW) — if
    // the flag leaked, the loaded body would run on the VM and succeed; with the
    // reset, it tree-walks and async fails.
    let dir = temp_dir("flag-leak");
    let m = write(&dir, "amod.sema", "(define (go) (await (async 1)))");
    let interp = Interpreter::new();
    interp.eval_str_compiled("(+ 1 2)").unwrap(); // sets vm_backend = true
    let expr = sema_reader::read(&format!(r#"(begin (load "{m}") (go))"#)).unwrap();
    let res = interp.eval_in_global(&expr);
    assert!(
        res.is_err(),
        "single-expr tree-walker eval must reset the backend flag so async in a \
         loaded file fails (the loaded body must not run on the VM), got {res:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
