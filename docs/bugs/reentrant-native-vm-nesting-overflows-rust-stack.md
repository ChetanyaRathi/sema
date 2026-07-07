# Re-entrant native→VM nesting overflows the Rust stack — uncatchable SIGABRT instead of a stack-overflow error

**Status:** FIXED (2026-07-07) — `sema_core::stack::maybe_grow` (stacker, gated off wasm) wraps the native→VM re-entry (`run_nested_closure`) and the value walkers (`Display`, `value_to_json`/`_lossy`, `pretty_print`), so deep-but-finite recursion grows the stack instead of aborting. Regression: `deep_structure_str_no_abort`, `deep_reentrant_recursion_no_abort` in `eval_test.rs`.
**Verified against:** fresh debug build at `acd44732` (`sema 1.28.1`) — still reproduces after the HOF-callback-dispatch fix (`6efc796f`)
**Area:** `sema-vm` re-entry path (`run_nested_closure`, `crates/sema-vm/src/vm.rs:1250`) + native recursive value walkers in `sema-core`

## Repro

```bash
sema -e '(define (nest d) (if (= d 0) 0 (+ 1 (first (map (fn (x) (nest (- d 1))) (list 0)))))) (println (nest 1000))'
# thread 'main' has overflowed its stack
# fatal runtime error: stack overflow, aborting     (SIGABRT, exit 134)
```

Debug builds abort at depth ~100–130; a release build survives to ~950. The
control — pure in-VM recursion — fails *cleanly* at any depth:

```bash
sema -e '(define (rec d) (if (= d 0) 0 (+ 1 (rec (- d 1))))) (println (rec 100000))'
# Error: Eval error: stack overflow: maximum call depth exceeded   (catchable, with stack trace)
```

Expected: the nested-HOF shape should hit the same guarded, catchable
`stack overflow` error as pure recursion, at whatever depth budget — never a
process abort.

### Same class: native recursive value walkers

Any deeply nested structure kills the walkers too (structure built
iteratively to stay under the VM frame guard):

```bash
sema -e '(define v (foldl (fn (acc _) (list acc)) (list 1) (range 5000))) (println (string-length (str v)))'
sema -e '(define v (foldl (fn (acc _) (list acc)) (list 1) (range 5000))) (println (string-length (json/encode v)))'
sema -e '(define v (foldl (fn (acc _) (list acc)) (list 1) (range 5000))) (pprint v)'
# all three: fatal runtime error: stack overflow, aborting   (exit 134)
```

(In the debug build, `str` handles depth 2000 and dies at 3000.) By contrast
`json/decode` **is** depth-guarded (serde_json's recursion limit) and fails
catchably:

```bash
# 1200-deep [[[…1…]]] JSON
# caught: {:message "json/decode: parse error … recursion limit exceeded …" …}
```

## Cause

Two related holes, both "real Rust stack consumed outside the VM's frame
accounting":

1. **Re-entry**: when a native HOF (`map` etc.) calls back into a closure,
   the callback runs via `run_nested_closure` (`crates/sema-vm/src/vm.rs:1250`,
   dispatched from the call-callback at `vm.rs:442`). Each native→VM re-entry
   nests a new `run` invocation on the *Rust* stack. The VM's frame guard
   (`MAX_FRAMES: usize = 2048`, `vm.rs:320`, checked at `vm.rs:2988`/`3052`)
   counts VM frames only — 2048 re-entries' worth of Rust stack is far more
   than the 8 MB main-thread stack, so the process dies before the guard
   fires.
2. **Walkers**: `Display for Value` (`crates/sema-core/src/value.rs:2121`,
   reached via `str`/`println`), `value_to_json`
   (`crates/sema-core/src/json.rs:12`, reached via `json/encode`), and
   `pretty_print` (reached via `pprint`, `crates/sema-stdlib/src/io.rs:651`)
   recurse structurally with no depth budget at all.

## Notes

- Fix directions: `stacker::maybe_grow` at the recursion points
  (rustc-style — covers both holes and keeps deep-but-legitimate data
  working), or (a) count native→VM re-entries toward the frame guard /
  a separate re-entry depth budget in `run_nested_closure`, plus (b) explicit
  depth budgets (or an iterative worklist) in the value walkers.
  `json/decode` already demonstrates the desired failure mode.
- Severity: **high** — an uncatchable abort reachable from ordinary user code
  (recursive function that maps over children — i.e. every hand-rolled tree
  walk) and from printing/serializing any deep structure; `try` cannot
  contain it, so one bad value kills a server/notebook process.
- Repros from the hunt session: `hunt-vm/z1.sema`–`z3.sema`,
  `p25-deep-reentrant.sema`, plus the deep-structure files in `hunt-stdlib/`.
