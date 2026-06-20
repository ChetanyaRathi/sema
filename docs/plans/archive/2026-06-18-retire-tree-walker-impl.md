# Tree-walker retirement — per-phase implementation designs (Opus-validated)

Companion to `2026-06-18-retire-tree-walker.md`. An initial draft was produced by a
fast model and then **reviewed phase-by-phase by Opus against the real source** — the
review found the draft substantially flawed (0 sound, 1 unsound, 6 needs-revision,
14 critical issues). This file is the **corrected** plan.

## The load-bearing fact the first draft missed
The VM is **not** self-sufficient today, and not in the way previously described: it
**delegates `load`/`import`/`eval`/`apply` back to the tree-walker** through
`sema_core::eval_callback` / `call_callback`, which are registered to `eval_value` /
`call_value` (`crates/sema-eval/src/eval.rs:82-83, 91, 102-103, 109`). The `__vm-load`
/ `__vm-import` / `__vm-eval` natives (`eval.rs:899-948`) all round-trip through these
callbacks. So Phase 1's real job is **repointing those callbacks + delegates to
VM-native implementations** — and a green test after a naïve consumer-flip would prove
nothing while the delegation is live.

## Two scope items that dwarf the rest

### A. Import on the VM requires giving closures a home-globals env (major VM change)
VM `Closure { func, upvalues }` carries **no globals/home-env pointer** (`vm.rs:47-50`).
Module top-level `define`s are **globals**, compiled to `GetGlobal/SetGlobal` resolved
against the *executing* VM's `self.globals` (`vm.rs:1134-1175`) — **not** upvalue cells.
So copying an exported closure to the caller and running it resolves `private-helper`
against the *caller's* globals → `Unbound` (exactly the `vm_module_test` failure CORE-2
hit). Upvalue capture only covers lexical locals of enclosing functions, never sibling
module globals. **To run `import` on the VM with tree-walker-equivalent isolation, add a
`globals: Rc<Env>` field to `Closure` and make `GetGlobal/SetGlobal` resolve against the
closure's home env** (cross-cutting: `vm.rs` GetGlobal/SetGlobal/MakeClosure + the
scheduler's task VMs). This is the real long pole; the draft's "upvalues give isolation"
premise was unsound. Since we are *retiring* the TW, "keep import on the TW" is not an
option — this VM change is required.

### B. CORE-2 is NOT closed by retiring the tree-walker (correction)
An earlier claim (including in conversation) was that the env↔closure leak dies with the
TW because the VM is cycle-free. **That is wrong.** `Closure.upvalues: Vec<Rc<UpvalueCell>>`
with `UpvalueState::Closed(Value)` can hold a `Value` that is the closure itself;
`resolve.rs:280-297` creates local recursive closures that reference their own name via
upvalue capture, and `docs/plans/2026-02-16-compilation-strategy-investigation.md:1014-1016`
already documents this as an Rc cycle and "the MOST common source of long-lived reference
chains." Only top-level defines (which go to globals) avoid it. **Retiring the TW removes
the TW's whole-`Env`-capture variant, but the VM's self-referential-upvalue cycle remains
an open GC question.** CORE-2 stays open; do not document it as closed.

---

## Phase 1a — VM macro expansion  *(corrected; was needs-revision)*
The spike proved the VM can *apply* a transformer; the draft's surrounding design was wrong.
- **Do NOT cache compiled transformer bytecode** — auto-gensym is resolved at lower time
  (`lower.rs:947-963`, baked as a constant), so a cached transformer reuses the *same*
  gensym across call sites, breaking hygiene (the spike only tested a single expansion).
  Recompile per call site, or cache only the parsed `(fn …)` `Value` (not bytecode).
- **Root the VM run at `caller_env`, not `global_env`.** `apply_macro` (`eval.rs:844`)
  binds params in `Env::with_parent(caller_env)`; it has 3 callers including the **live TW
  evaluator's lazy expansion** at `eval.rs:721-725`. Either pass an `Rc` rooted at
  `caller_env` to the VM, or keep the TW lazy-expansion path on the old eval-based
  `apply_macro` and use the VM variant only in the pre-expansion path.
- **No `sema-vm` type in `sema-core::Macro`** (would create a `sema-core → sema-vm` cycle).
  If caching, use a thread-local in `sema-eval` keyed by `Rc::as_ptr(&macro)`.
- **Drop the no-op tasks:** `eval_defmacro` is already a pure destructure (no `eval_value`);
  `apply_macro` is already `pub`; both `macroexpand` paths already call it. (Author misread.)
- If the `Macro` struct changes, update both literals: `special_forms.rs:844` **and**
  `eval.rs:982` (`__vm-defmacro`).

## Phase 1b — load/import on the VM  *(UNSOUND as drafted → see scope item A)*
Real work = the closure-home-globals VM change (A), then make `__vm-import` resolve +
compile + run the module body on the VM rooted at the module's globals, copying only
exports. `load` is already VM-native *inside* `eval_load_body` via the `vm_backend` flag
(`special_forms.rs:1747-1763`); the `__vm-load` native still TW-round-trips and must be
repointed too. Gate on `vm_module_test` (isolation) staying green.

## Phase 1c — eval/call bridge → VM  *(corrected; was needs-revision)*
- The consumer to repoint is **`__vm-eval`** (`eval.rs:899-910`) + `debug_evaluate`
  (`vm.rs:2787-2808`, which already has the correct fresh-VM pattern to copy) — **not**
  stdlib HOFs. Also repoint **sema-llm's** own `set_eval_callback(eval_value)`
  (`eval.rs:91,109`).
- **Do not add a redundant `vm_call_callback`** — VM closures are already native-wrapped
  with full C1/async/fresh-VM dispatch (`vm.rs:2405-2466`); re-dispatching risks
  double-upvalue-closing. The genuinely-TW-only pieces are `call_value`'s `Lambda` arm +
  `MultiMethod` recursion + `run_trampoline` (`eval.rs:413-471`); on the VM path raw
  `Lambda` values never occur — verify by grep, then provide a VM call callback that
  handles `NativeFn`/`Keyword`/`MultiMethod` and errors on raw `Lambda`.

## Phase 1d — prelude on the VM  *(corrected; folds into 1a)*
The prelude is **exclusively 9 `defmacro` forms**; they expand to `nil` and the real
registration happens via `eval_value` inside `expand_for_vm_in` (`eval.rs:214`). So 1d is
a no-op rename **unless 1a migrates the `defmacro`-registration path off `eval_value`**.
Treat 1d as **absorbed into 1a**. The dual-eval suite **cannot** verify this phase (both
backends share `load_prelude`) — use **absolute oracle tests** instead (e.g.
`(-> 5 (+ 3) (* 2)) == 16`, `when-let`/`if-let`/`dotimes`/`for-range`).

## Phase 2 — public API + consumers  *(corrected; was needs-revision)*
- The embedding API is **`sema::Interpreter`** (`crates/sema/src/lib.rs`), and
  `InterpreterBuilder::build()` (`lib.rs:84-108`) does **not** call `register_vm_delegates`
  / `load_prelude`. Fix the builder to match `sema_eval::Interpreter::new()` **before** any
  VM flip, or embedders lose load/import + all prelude macros.
- **Respect define-persistence contracts:** `eval`/`eval_str` use a **child** env (no
  persistence); `eval_in_global`/`eval_str_compiled` use the **global** env (persistence).
  Move the global-env methods to the VM (parity holds); keep child-env isolation for the
  others or document a deliberate break. Then drop the sema-wasm Tree toggle.

## Phase 3 — test migration  *(corrected; was needs-revision)*
- **Gate on a verified Phase-1 completion checkpoint** (callbacks repointed; `__vm-*` no
  longer route through `eval_value`). Until then the `eval()` flip passes for the *wrong
  reason* (delegation runs the TW under the hood).
- The literal-value oracle **already exists** for every `dual_eval_tests!` case
  (`$input => $expected`); collapsing to VM keeps it. The real gap is **legacy
  `dual_eval_error_tests!` entries** (assert-only, no anchor) — upgrade to a substring
  anchor, and audit VM-vs-TW error wording (44 error blocks) before dropping `_tw`.
- **Don't recycle the `dual_eval_tests!` name** for single-backend cases (it generates
  `_tw`+`_vm`); introduce `vm_eval_tests!` and update CLAUDE.md.
- Real fallout vectors are narrow: **sandbox/capability parity** (~180 lines) and
  **async-within-one-program**; the ~40 active `server_test` router tests are the Phase-1c
  closure canary. The "~1,100 just flip" framing is otherwise overstated.

## Phase 4/5 — delete TW + docs  *(corrected; was needs-revision)*
- **Relocate `SPECIAL_FORM_NAMES`** out of `special_forms.rs` first — it's a TW-free
  constant used by the REPL + all of `sema-lsp` (8+ files); deleting the file otherwise
  breaks `sema` and `sema-lsp` compilation.
- **Gate deletion** on a grep that `eval_value` has no remaining callers
  (`apply_macro:882`, `expand_for_vm_in:214`, `apply_lambda:835`, `eval_string:329`,
  `eval:336` must all be removed/rewritten by 1a–1c first).
- **Do not claim CORE-2 is closed** (see scope item B). Reframe the doc note accordingly.

---

## Net assessment
The retirement is **viable but materially larger** than the first draft implied. The real
critical path is the **closure-home-globals VM change** (scope A) — without it, `import`
cannot run on the VM with correct isolation, and that gates Phases 3–5. Recommended order:
**A (closure home-globals) → 1a (macro expansion, caller_env, no cache) → 1c (eval bridge:
`__vm-eval` + llm callback) → 1b (`__vm-import` on VM) → 1d (absorbed) → 2 → 3 → 4/5.**
Build the raw full-result review into the git record; the verdicts were 1 unsound (1b) +
6 needs-revision, which is why none of this should have shipped unreviewed.
