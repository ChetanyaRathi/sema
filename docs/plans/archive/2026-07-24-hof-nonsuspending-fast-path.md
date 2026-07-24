# HOF non-suspending direct-dispatch fast path

**Status:** IMPLEMENTED (2026-07-24, same day) — `crates/sema-vm/src/hof_sync.rs`
plus `NativeSuspensionClass`/`SyncHofHost` in sema-core and sync loops in the
stdlib HOFs. All acceptance criteria met: deriv 4.78×→1.18×, string-pipeline
3.92×→1.12×, higher-order-fold 3.25×→0.78×, flat/nested micros faster than the
pre-flip engine; async matrix no-regress; 7230 workspace tests green; release
gate lifted (see `docs/deferred.md` PERF-RESIDUAL-1 RESOLVED and the recovery
section in `evidence/unified-cooperative-runtime/benchmark-vs-baseline.md`).

Implementation deviations from §4 (all documented in `hof_sync.rs`):

- The guard (`reject_callback_during_runtime_quantum`) was NOT relaxed at all.
  Instead of a non-rejecting `call_callback` path, the VM installs a
  `SyncHofHost` capability into `NativeCallContext` during in-quantum native
  dispatch; HOFs run their element loops through it. `call_value` is untouched.
- Inert **native** callbacks (`(map string/to-number xs)`, `(foldl + 0 xs)`)
  also take the fast path — natives without a runtime ABI cannot emit outcomes,
  so no analysis is needed. This is what recovers string-pipeline.
- The `may_suspend` cache is keyed on an env-chain version fingerprint, so a
  REPL/notebook redefinition re-analyzes instead of tripping the
  "suspended on the sync path" error (covered by
  `vm_async_test::global_redefinition_reroutes_to_cooperative_path`).
- Chunking boundary: the element. Between elements the parent quantum's budget
  is honored (tail handed back as the HOF's ordinary mid-chain continuation);
  nested-HOF `Call`s past a sync-nesting cap of 16 settle in a flat
  restricted-driver de-opt (`resume_pending_restricted`), keeping `(nest 1000)`
  off the Rust stack.
- Suspension classes live on `NativeFn` (`Inert` derived from a missing runtime
  ABI; `CallbackDriven(positions)` marked at `register_hof`; `MaySuspend`
  default for everything with a runtime ABI).

Original brief follows.

**Status (original):** design / handoff brief (2026-07-24). Targeted recovery of
the compute-perf regression tracked as **PERF-RESIDUAL-1 (REOPENED)** in
`docs/deferred.md`. This is the *deep* change; the safe micro-opts (batch
`turn_instructions`, collapse ambient TLS reads, cut per-call clock reads) are a
separate, smaller effort and do **not** address the root cause below.

Owner note: this is a **release gate** — no release until the compute path is
recovered to an accepted band. The change relaxes a deliberately-guarded runtime
invariant, so correctness care dominates.

---

## 1. Symptom (measured, reproducible)

Same machine (macOS arm64), release builds, pre-flip baseline binary at
`3f111e83` (built in `/Users/helge/code/sema/.worktrees/bench-baseline`) vs
post-merge `main` (`e0e5acb8`, release-with-debug):

| microbench | pre-flip baseline | post-flip | ratio |
|---|---|---|---|
| flat `map` (10M trivial `(fn (x) (+ x 1))` element calls) | 375 ms | 1302 ms | **3.47×** |
| nested `map` (one level of nesting, ~equal element count) | 416 ms | 1623 ms | 3.90× |
| `deriv` (Gabriel, 250k derivations) | 630 ms | 3109 ms | **4.93×** |

Standard `jake bench` suite (min time): `deriv` 4.78×, `string-pipeline` 3.92×,
`higher-order-fold` 3.25×; `mandelbrot`/`hashmap` ~1.1×; `tak`/`nqueens`/
`closure-storm`/`throw-catch` ≤1.06× (noise).

**Key observation:** the *flat, single-level* `map` — no nesting, no fallback,
pure 0c fast path — is already **3.47×**. So the regression is the per-element
*and* per-call cooperative-dispatch overhead itself, not nesting.

**Why the branch's perf validation missed it:** the branch measured `primes`
(`filter` with a *primality-checking* callback). That callback does real work,
so per-element dispatch overhead is a small fraction → 1.09× (looked fine). Real
compute (`deriv`, string ops, flat maps) has **cheap callbacks** (`cons`/`car`/
`+`/`=`); there the dispatch overhead *dominates* → 3.5–5×. Same root as the
`cons-1m` 1.38× "allocator/GC-registry" residual noted in
`docs/plans/evidence/unified-cooperative-runtime/benchmark-vs-baseline.md`, just
exposed harder.

Reproduce: microbenchmarks in
`.../scratchpad/flat.sema`, `nested.sema`, `deriv-long.sema` (copy into the repo
under `examples/benchmarks/` if you want them permanent). Profiled with macOS
`sample` on `deriv-long` (~7000 non-idle samples).

## 2. Root cause (profile-backed)

Profile of `deriv` (leaf samples; `semaphore_wait_trap`=idle I/O-pool threads,
ignore):

- `Runtime::drive_selected` **1528** (5449 cumulative) — scheduler drive loop, top frame
- malloc/free **~1124** + `Vec<CachedGlobal>` churn **485** — per-VM-creation allocation
- `_tlv_get_addr` **599** — thread-local reads (ambient scopes, eval ctx, quantum state)
- clock reads (`sub_timespec`/`mach_absolute_time`) **415** — per-drive-call
- task-scope swap (`scope_task_context`/`TaskScopeSwap`) **413**
- llm/otel ambient-empty checks **277**
- GC trace / escaping-value **328**
- `VM::run_inner` (the actual VM work) **~839** — only ~15–20% of the time

**The mechanism.** Every `map`/`filter`/`foldl`/`for-each` **call** returns
`NativeOutcome::Call` and **round-trips through the drive loop**:

```
main task run_quantum hits the HOF native
  → native returns NativeOutcome::Call{callable, args:[first], continuation}
  → run_quantum returns the outcome
  → Runtime::drive_selected  (clock read, ready check, per-turn machinery)
  → Runtime::invoke_vm_callback_loop  (runs the element chain in-place on the scratch VM)
      per element: escaping-value snapshot, setup_for_call, run_quantum,
                   continuation.resume rebuilds a NativeCall (heap Vec alloc)
  → chain settles → PendingStage::Apply
  → main task resumes (re-enters run_quantum past the HOF)
```

Each round trip pays the clock read, `TaskScopeSwap` install/restore (3 ambient
TLS checks), `enter_runtime_quantum`, `QuantumIdGuard`, `scope_task_context`,
plus the per-element costs. `deriv` issues **~8M HOF calls** → ~8M round-trips.
`deriv` (many tiny maps) is worse than flat map (few big maps) because the
per-call round-trip is amortized over fewer elements in `deriv`.

The 0c in-place loop (`invoke_vm_callback_loop`) already avoids *per-element*
ready-queue round-trips, but the **per-call** round-trip and the per-element
`run_quantum`/continuation wrapper remain. For cheap callbacks that overhead is
3.5–5× the useful work.

## 3. Current architecture (read these first)

- **HOF natives:** `crates/sema-stdlib/src/list.rs`. `map_call()` (~L85) builds
  `NativeOutcome::Call{ callable, args:vec![first], continuation: MapContinuation }`.
  `MapContinuation::resume` (~L55) pushes the result, pops the next element,
  returns `NativeOutcome::Call` for it, or `NativeOutcome::Return(list)` at the
  end. Same shape for `filter`, `foldl`/`reduce` (`start_fold`, ~L604),
  `for-each`, `sort-by`.
- **0c in-place fast path:** `Runtime::invoke_vm_callback_loop`
  (`crates/sema-vm/src/runtime/state.rs:3994`). Drives the whole element chain on
  ONE reused scratch VM (`RuntimeState::scratch_callback_vm: Option<VM>`,
  `state.rs:531`; taken/reset via `take_scratch_callback_vm`, `state.rs:3915`).
  Read its doc comment (`state.rs:3930–3990`) fully. **It explicitly falls back
  to the parked path on "a nested HOF" or any real suspension** (`state.rs:3970`,
  the `_ => break ElementOutcome::Suspended` arm at `state.rs:4203`).
- **The guard (the thing to relax):**
  `crates/sema-core/src/context.rs:1759` `reject_callback_during_runtime_quantum`
  — makes `call_callback` / `call_callback_owned` / `eval_callback`
  (`context.rs:1725`/`1747`/`1715`) **error inside a runtime quantum**. Rationale:
  a synchronous nested callback can't handle a *suspending* callback. Protected
  by tests `context.rs:1340` and `context.rs:1365` — those must keep passing
  (the guard stays for the general case).
- **The pre-flip model** (what we're partially restoring): per AGENTS.md
  "Callback architecture", stdlib HOFs called `sema_core::call_callback` →
  `call_value` (`crates/sema-eval/src/eval.rs:1780`) → a **synchronous nested
  eval**, directly, no round-trip. That is exactly what the guard now blocks
  in-quantum.

## 4. The fix

**Goal:** when a HOF's callback *provably cannot suspend*, run the HOF
synchronously — per-element direct calls, returning `NativeOutcome::Return`
without ever emitting `NativeOutcome::Call` — eliminating the drive round-trip
and the per-element cooperative wrapper. Keep today's cooperative path as the
fallback for callbacks that *can* suspend.

Two independent sub-problems:

### 4A. "Can this callback suspend?" analysis (`may_suspend`)

A callback can suspend iff its body can transitively reach a suspension point:
the async/channel/spawn/sleep family and anything that yields to the scheduler
(the natives that produce `NativeOutcome::Call`/structural `Pending`; see the
yield-signal mechanism in `crates/sema-stdlib/src/async_ops.rs` and every
`NativeOutcome::Call` producer).

- Compute a conservative `may_suspend: bool` **per `Function`** (in `sema-vm`).
  Scan the compiled bytecode (`Chunk`; opcodes in `opcodes.rs`) for calls to
  suspension-capable natives and for any construct that can yield. **Be
  conservative: unknown/dynamic/indirect call target ⇒ `may_suspend = true`.**
- **Transitivity:** a callback calls other functions. Either (a) a bounded
  transitive closure over statically-resolvable call targets, marking
  `may_suspend = true` for any target you can't resolve; or (b) simpler and
  safe: `may_suspend = false` **only** when the callback's bytecode uses solely a
  whitelist of known-pure opcodes/natives (arithmetic, comparisons,
  `cons`/`car`/`cdr`/`list`/`vector` builders, field/keyword access, and calls to
  other functions already proven `may_suspend = false`). Everything else ⇒ true.
  Note nested non-suspending HOFs are themselves non-suspending, so `deriv`'s
  `map`-in-`map` qualifies once transitivity is handled — this is the case that
  currently *falls back to the parked path*; the fix keeps it synchronous.
- Cache the result (compute once): a `Cell<Option<bool>>` on `Function`, or
  compute during the compile/resolution pass (`crates/sema-vm/src/compiler.rs`).
  **Correctness asymmetry:** a false *negative* (calling a suspending callback
  "non-suspending") is a correctness bug; a false *positive* just loses the
  optimization. Bias hard toward `may_suspend = true`.

### 4B. Safe synchronous in-quantum dispatch

When `may_suspend == false`, the HOF runs the callback synchronously.

- Add a non-rejecting synchronous call path used **only** after the analysis
  proves non-suspension — e.g. `call_callback_nonsuspending(ctx, func, args)`
  that skips `reject_callback_during_runtime_quantum` and runs `call_value`. Keep
  the guard intact for the general `call_callback`.
- **Re-entrancy / state-borrow:** the `RuntimeState` cell must NOT be borrowed
  across a nested callback run (see the `debug_assert` at `state.rs:4064`:
  "RuntimeState borrowed at in-place HOF loop entry — a blocking debug stop would
  deadlock the state cell"). Verify `call_value` can run on a fresh/scratch VM
  here without conflicting borrows. `invoke_vm_callback_loop` already runs nested
  `run_quantum` on a scratch VM *from the drive level*; doing it from **inside a
  native** (`dispatch_native`, within the parent VM's `run_inner`) is the new
  wrinkle — confirm the parent VM's `run_inner` stack tolerates a nested
  synchronous callback run, or route the synchronous dispatch so it doesn't
  re-enter the parent's dispatch loop in a conflicting way.
- **Budget & cancellation:** the cooperative path debits one shared instruction
  budget across the element chain and checks cancellation per element so a huge
  `map` still yields to sibling tasks. A fully-synchronous "run to completion"
  loses that. Preserve it: run the synchronous loop in **bounded chunks** — check
  cancellation between elements and, if the instruction budget for this drive
  quantum is exhausted, hand the *remaining* elements back to the cooperative
  path (or return a continuation) so fairness/cancellation still hold. Small
  inputs finish in one chunk (the common case); only pathologically large
  synchronous maps yield. Decide the chunking boundary.
- **GC invariant I2 (CORE-2):** traced task-held state (AGENTS.md "Invariant I2";
  `docs/plans/2026-07-02-core2-gc.md`). The scratch VM is traced via
  `scratch_callback_vm`; a synchronous path must keep the callback's transient
  values reachable/traced for the run's duration. Don't create an untraced VM
  holding live `Value`s across a potential collection point.

### Where the code lands

- `may_suspend`: `sema-vm` — `Function` + a bytecode scan (`opcodes.rs`,
  native-table resolution); computed in `compiler.rs` or lazily/memoized.
- HOF natives: `crates/sema-stdlib/src/list.rs` — `map`/`filter`/`foldl`/
  `reduce`/`for-each`/`sort-by` entry points choose synchronous vs
  `NativeOutcome::Call` based on the callback's `may_suspend`.
- Guard relaxation: `crates/sema-core/src/context.rs` (new non-rejecting path) +
  `crates/sema-eval/src/eval.rs` `call_value`.
- Possibly cleanest: perform the synchronous dispatch at the runtime level
  (`state.rs`) reusing the scratch-VM/quantum machinery but *without* the drive
  round-trip, when the native signals "callback is non-suspending".

## 5. Acceptance criteria

- **Benchmarks** (release, macOS arm64, baseline binary at `3f111e83` in
  `.worktrees/bench-baseline`): `flat`, `nested`, `deriv`, `string-pipeline`,
  `higher-order-fold` recover to **≤1.2× vs pre-flip** (stretch: ≤1.1×). Async
  workloads (spawn-storm, channel-pingpong, sleep-storm) must NOT regress —
  re-run the `benchmark-vs-baseline.md` matrix. Update that file + the
  PERF-RESIDUAL-1 ledger.
- **Correctness (full CI-equivalent):** `cargo nextest run --workspace` (all
  7221 green), `jake examples`, `jake smoke-bytecode`, `jake lint`,
  `scripts/check-unified-runtime-inventory.sh --check`.
- **New tests (required):**
  - a `map`/`filter`/`foldl` with a **suspending** callback (`async/sleep`,
    `channel/recv`, `async/spawn` in the callback body) still works — goes
    through the cooperative fallback (`crates/sema/tests/vm_async_test.rs`).
  - a **nested** non-suspending HOF (`map`-in-`map`) produces correct results and
    takes the fast path (assert via an instrumented counter or a benchmark
    threshold, not just timing).
  - the guard tests `context.rs:1340`/`1365` still pass (guard intact for the
    general case).
- **No new `unsafe`**, no `#[allow]` on clippy without justification (see the
  idiomatic-rust conventions), comments describe the code as-is (no change
  narration) per AGENTS.md "Code Style".

## 6. Risk notes

- The guard is deliberate; a wrong relaxation reintroduces the re-entrancy /
  suspension bugs the cooperative model was built to eliminate. The `may_suspend`
  analysis is the safety keystone — conservative to a fault.
- Watch the fallback boundary: a callback proven non-suspending that nonetheless
  hits an *unexpected* runtime outcome must not silently corrupt the chain — it
  should surface as an error, not a wrong result.
- Prior art / context: `docs/plans/evidence/unified-cooperative-runtime/`
  `benchmark-vs-baseline.md` (0b/0c slices, `invoke_vm_callback_loop` = 0c Task
  C), `docs/plans/archive/2026-07-16-runtime-fast-path-recovery.md` (Task C
  detail), `docs/deferred.md` PERF-RESIDUAL-1 (reopened, release gate).
