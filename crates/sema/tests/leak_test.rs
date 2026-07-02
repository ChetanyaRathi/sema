//! CORE-2 leak-sizing oracle: recursive local closures form `Rc` cycles that
//! reference counting cannot reclaim, so heap growth is unbounded in
//! long-lived sessions (REPL, notebook, server, agents).
//!
//! The `#[ignore]`d tests are the acceptance oracle for the cycle-collector
//! work (`docs/plans/2026-07-02-core2-gc.md`): they assert BOUNDED live-heap
//! growth and FAIL today, printing the measured leak rate. Un-ignore them when
//! the collector lands. The non-ignored controls prove the measurement harness
//! itself is sound (same workload shapes without cycles stay flat).
//!
//! Run the oracle: `cargo test -p sema-lang --test leak_test -- --ignored --nocapture`

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use sema_eval::Interpreter;

/// Wraps the system allocator, tracking net live bytes. Coarse but exactly
/// what the leak needs: a cycle keeps its allocations live forever, so net
/// growth across a churn workload measures the leak directly.
struct CountingAlloc;

static LIVE_BYTES: AtomicIsize = AtomicIsize::new(0);

// SAFETY: delegates every operation to `System`; only adds relaxed counter
// bookkeeping, which cannot violate allocator invariants.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE_BYTES.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            LIVE_BYTES.fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        new_ptr
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

/// The test harness runs tests on separate threads; serialize so each
/// measurement sees only its own allocations.
static MEASURE_LOCK: Mutex<()> = Mutex::new(());

fn live_bytes() -> isize {
    LIVE_BYTES.load(Ordering::Relaxed)
}

/// Net live-heap growth of `f`, after `warmup` has populated caches,
/// the interner, and lazily-initialized statics.
fn measure(warmup: impl FnOnce(), f: impl FnOnce()) -> isize {
    warmup();
    let before = live_bytes();
    f();
    live_bytes() - before
}

const CHURN_RECURSIVE: &str = r#"
(define (churn)
  (define (loop n) (if (<= n 0) 0 (loop (- n 1))))
  (loop 3))
(define (run n)
  (if (<= n 0) nil
      (begin (churn) (run (- n 1)))))
"#;

const CHURN_FLAT: &str = r#"
(define (churn)
  (define (helper n) (- n 1))
  (helper 3))
(define (run n)
  (if (<= n 0) nil
      (begin (churn) (run (- n 1)))))
"#;

const ITERS: usize = 20_000;
/// Generous per-iteration allowance for cache/interner drift. The leak is two
/// orders of magnitude above this (~300 B/iter), so the bound is not tight.
const BYTES_PER_ITER_BOUND: isize = 16;

fn assert_bounded_churn(program: &str, label: &str) {
    let _guard = MEASURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let interp = Interpreter::new();
    interp.eval_str_compiled(program).expect("defs eval");
    let grown = measure(
        || {
            interp.eval_str_compiled("(run 2000)").expect("warmup");
        },
        || {
            interp
                .eval_str_compiled(&format!("(run {ITERS})"))
                .expect("workload");
        },
    );
    let per_iter = grown / ITERS as isize;
    println!("{label}: net heap growth {grown} B over {ITERS} iters ({per_iter} B/iter)");
    assert!(
        grown < ITERS as isize * BYTES_PER_ITER_BOUND,
        "{label}: leaked {grown} bytes over {ITERS} iterations ({per_iter} B/iter); \
         bound is {BYTES_PER_ITER_BOUND} B/iter (CORE-2)"
    );
}

/// CORE-2 oracle, VM upvalue shape: each `churn` call creates a recursive
/// local closure whose self-capture is an `Rc<UpvalueCell>` closed over the
/// closure itself — an unreclaimable cycle. Grows ~300 B/iter today.
#[test]
#[ignore = "CORE-2 acceptance oracle: fails until the cycle collector lands (docs/plans/2026-07-02-core2-gc.md)"]
fn recursive_local_closure_growth_is_bounded() {
    assert_bounded_churn(CHURN_RECURSIVE, "recursive-local-closure churn");
}

/// Control: identical workload shape, no self-capture, no cycle. Stays flat —
/// proves the harness measures the cycle, not general eval-churn noise.
#[test]
fn nonrecursive_local_closure_growth_is_bounded() {
    assert_bounded_churn(CHURN_FLAT, "non-recursive control churn");
}

const TEARDOWN_ITERS: usize = 10;

fn interpreter_teardown_growth(program: Option<&str>) -> isize {
    let _guard = MEASURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let run_once = || {
        let interp = Interpreter::new();
        if let Some(src) = program {
            interp.eval_str_compiled(src).expect("eval");
        }
    };
    measure(
        || (0..3).for_each(|_| run_once()),
        || (0..TEARDOWN_ITERS).for_each(|_| run_once()),
    )
}

/// CORE-2 oracle, Env shape: `(define (f x) x)` makes the global env bind a
/// closure whose `Closure::globals` points back at that env
/// (`Env → binding → NativeFn → VmClosurePayload → Closure → globals → Env`),
/// so dropping the Interpreter leaks its ENTIRE global environment — every
/// builtin, the bindings map, all of it. One user-defined function suffices.
#[test]
#[ignore = "CORE-2 acceptance oracle: fails until the cycle collector lands (docs/plans/2026-07-02-core2-gc.md)"]
fn interpreter_teardown_frees_global_env() {
    let grown = interpreter_teardown_growth(Some("(define (f x) x)"));
    let per_drop = grown / TEARDOWN_ITERS as isize;
    println!(
        "interpreter teardown with one define: net growth {grown} B over {TEARDOWN_ITERS} drops ({per_drop} B/drop)"
    );
    assert!(
        grown < TEARDOWN_ITERS as isize * 4096,
        "each dropped Interpreter leaked ~{per_drop} bytes (whole global env pinned by the \
         Env⇄Closure cycle; CORE-2)"
    );
}

/// CORE-2 oracle, builtin-delegate shape: even with NO user code the global
/// env leaks, because `register_vm_delegates` (and the deftool/defagent
/// registrars) install `NativeFn`s whose boxed `Fn` strongly captures the very
/// `Rc<Env>` they are registered into (`crates/sema-eval/src/eval.rs:558` and
/// ~10 siblings) — `Env → binding → NativeFn → Box<dyn Fn> capture → Env`.
/// Measured ~166 KB leaked per Interpreter drop. Unlike the closure shapes,
/// these captures hide inside an opaque `Box<dyn Fn>` a collector cannot
/// trace; the fix is to make delegate captures weak (or payload-traced), after
/// which this test goes green independently of the cycle collector.
#[test]
#[ignore = "CORE-2 acceptance oracle: fails until delegate env-captures are made traceable/weak (docs/plans/2026-07-02-core2-gc.md)"]
fn interpreter_teardown_without_defines_is_bounded() {
    let grown = interpreter_teardown_growth(None);
    let per_drop = grown / TEARDOWN_ITERS as isize;
    println!(
        "interpreter teardown (no defines): net growth {grown} B over {TEARDOWN_ITERS} drops ({per_drop} B/drop)"
    );
    assert!(
        grown < TEARDOWN_ITERS as isize * 4096,
        "each dropped Interpreter leaked ~{per_drop} bytes with no user code \
         (builtin delegates strongly capture their home env; CORE-2)"
    );
}
