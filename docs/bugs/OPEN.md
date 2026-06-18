# Open bug items

Status after the 2026-06-18 triage (`2026-06-18-triage.md`) and fix passes.
**22 audit findings + 8 decided items are fixed** (see git history). What remains:

---

## Needs a (new) decision

### CORE-2 — Rc cycle on every named `define` (memory leak)
`crates/sema-eval/src/special_forms.rs` (eval_define) + `crates/sema-core/src/value.rs`.
Self-referential closures from `(define (f …) …)` never drop → memory grows in
long REPL/notebook/server sessions.

**The decided "Weak captured-env" approach was implemented and DROPPED.** It
breaks the *common* "module exports a function that calls a private helper"
pattern: a selectively-imported `public-api` holds its module env only weakly,
so `private-helper` gets freed and calls fail with `Unbound private-helper`
(caught by `vm_module_test::vm_backend_import_keeps_tree_walker_isolation`). The
Weak-vs-modules tension can't be resolved without either keeping the module env
alive for imported lambdas (import-path change) or a GC.

Re-decide:
- **(C) Accept + document** the leak (zero behavior change; the safe default given the above). Add a memory-bound test + a note.
- **(A′) Import-aware Weak**: keep the Weak idea but make `import`/`load` retain the module env strongly for any exported lambda. More design; revisit later.

---

## Deferred (revisit when triggered)

### WASM-4 — `register_wasm_io` ~1093-line function
Latent V8 ARM64 large-function crash risk. Pure refactor; revisit if it recurs.

### C1 follow-ups (minor, documented)
The in-VM HOF routing fixed `set!`-through-HOF, but two unrelated symptoms of the
closure-as-NativeFn wrapping remain: `(type (fn …))` reports `:native-fn`, and a
VM error caught from inside a HOF lacks a `:stack-trace`. Low priority.

---

## Done in this pass (2026-06-18)
VM-1 (P0 verifier), C1 (set!-through-HOF), time/parse UTC docs, NB-2 (localhost
bind), STD-10 (db/exec-batch docs), eval-tw oracle (literal expected values),
platform-windows (temp_dir + separator-agnostic), fragile-error (structured
matching). All verified; full suite green (5723 passed).
