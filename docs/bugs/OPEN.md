# Open bug items — decided plan (2026-06-18)

Remaining findings after the triage (`2026-06-18-triage.md`) and the two fix
passes that closed 22 findings. Directions below were decided with the maintainer
on 2026-06-18. Everything not listed here is fixed (see git history + triage).

---

## Quick — doc / config only

### time/parse naive datetimes  →  **document as UTC**
`crates/sema-stdlib/src/datetime.rs`. No behavior change. Document that naive
(offset-less) strings are interpreted as UTC; recommend explicit-offset strings
for other zones. Update `website/docs/stdlib/datetime.md`. (The old masking test
range can stay; add a test asserting UTC interpretation explicitly.)

### NB-2 notebook auth  →  **localhost-only + document**
`crates/sema-notebook/src/server.rs`. Bind to `127.0.0.1` by default; document
that the notebook server is a trusted-local tool and exposing it to a network is
the operator's responsibility. No auth layer.

### STD-10 db/exec-batch SQL injection  →  **document + steer to params**
Document that `db/exec-batch` is for static SQL only; point users to
parameterized `db/exec`. No code change. (Consistent with the opt-in-safety stance.)

---

## Scoped code fixes

### VM-1 — `.semac` verifier missing `CallNative` arm  ·  P0  →  **fix**
`crates/sema-vm/src/serialize.rs` `validate_chunk_bytecode`. Thread the native-
table length in and add a `CallNative` arm validating `native_id < n_natives`.
Add a malformed-`.semac` regression test. Small, high value.

### eval-tw oracle circularity  →  **complete literal expected values**
`crates/sema/tests/dual_eval_*.rs`. Convert the ~23 foundational list/collection
ops to hand-constructed literal expected values so the oracle no longer depends
on the tree-walker. Medium mechanical effort.

### platform-specific-windows  →  **invest now**
`crates/sema/tests/integration_test.rs`. cfg-gate shell/`sh` tests, normalize
path separators in path/join assertions (or have path/join return `/` uniformly),
and replace `/tmp` hardcodes with `std::env::temp_dir()`. ~20+ sites.

### fragile-error-message-matching  →  **extend structured matching** (minor)
Replace the remaining `.contains("Permission denied")` / `"outside allowed
directories"` checks (~26 sites) with `matches!(err.inner(), SemaError::PermissionDenied{..} | ..::PathDenied{..})`.

---

## Large — each warrants its own focused change + review

### C1 — `set!` through stdlib HOF callbacks lost on VM  ·  HIGH  →  **route HOF callbacks in-VM**
Extend `call_callback` / the HOF dispatch so stdlib higher-order functions invoke
closures inside the VM instead of the fresh-VM fallback, eliminating the
upvalue-close-before-call divergence. Larger change across the stdlib↔VM boundary;
needs its own plan + dual-eval regression coverage. (Chosen over the smaller
"stop early-closing upvalues" option for a clean, no-per-access-cost fix.)

### CORE-2 — Rc cycle on every named define (memory leak)  →  **Weak captured-env ref**
`crates/sema-eval/src/special_forms.rs` + `crates/sema-core/src/value.rs`. Store
the lambda's captured env as `Weak`, reconstructing the parent chain on call, so
self-referential closures can be freed. Preserves self-recursion + semantics;
intricate — needs its own plan + thorough recursion/closure/memory tests.

---

## Deferred (revisit when triggered)

### WASM-4 — `register_wasm_io` ~1093-line function  →  **defer**
Latent V8 ARM64 large-function crash risk. Pure refactor; revisit if the crash
recurs in the playground. No action now.
