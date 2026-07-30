# Async grammar-fuzzer findings

Findings from building and running the async fuzzing mode
(`SEMA_FUZZ_ASYNC=1`, plan
`docs/plans/archive/2026-07-29-async-grammar-fuzzer.md`). Phase 1 recorded
findings 1-3; phase 2 fixed them (Resolutions below); phase 3 added the
shutdown-leak harness. Each entry has a reproduction that needs no fuzzer
state.

## 1. Cancelling an offloaded blocking `sleep` pins its executor worker

**Status:** observed during construct verification (not a fuzzer seed).
**Suspected area:** `sleep_via_executor` / `SleepCancelHook` in
`crates/sema-stdlib/src/system.rs`; executor shutdown in the runtime.

The worker closure is one uninterruptible `std::thread::sleep(ms)`. Cancelling
the task settles the promise immediately (correct), but the worker thread keeps
sleeping. At process exit a constant ~2 s shutdown grace is the visible
symptom, regardless of how much sleep remains:

```bash
# settles in ~4 ms in-program, exits after ~2.0 s (same for 600000):
time ./target/debug/sema -e \
  '(let ((p (async (sleep 60000)))) (async/sleep 3) (async/cancel p)
     (try (async/await p) (catch e (:type e))))'
```

Observed: prints `:cancelled`, then the process takes ~2.0 s to exit. A
non-cancelled control (`(sleep 300)` variant) exits as soon as the sleep ends.

Consequence beyond exit latency: every cancelled blocking sleep pins one
executor thread for its full nominal duration. Enough of them exhaust the
blocking pool and delay unrelated offloaded work. The generator therefore caps
blocking-sleep cancel targets at 1500 ms (`gen-async-cancel`); a 60 s target
would serialize later offload leaves behind dead workers.

## 2. `async/cancelled?` immediately after `async/cancel` depends on target state

**Status:** observed during construct verification (not a fuzzer seed).
**Suspected area:** cancel request handling in the runtime
(`crates/sema-stdlib/src/async_ops.rs` cancel op; runtime state transitions).

`(async/cancel p)` on a task that has not started yet settles it synchronously:
`(async/cancelled? p)` right after returns `#t`. The same read on a task that
is already parked returns `#f`; the promise only settles as cancelled when the
runtime processes the request, and the read turns `#t` after `(async/await p)`:

```bash
# not started yet -> #t
./target/debug/sema -e \
  '(let ((ch (channel/new 1))) (let ((p (async (channel/recv ch))))
     (async/cancel p) (async/cancelled? p)))'
# parked (root yielded first) -> #f, then #t after the await settles
./target/debug/sema -e \
  '(let ((ch (channel/new 1))) (let ((p (async (channel/recv ch))))
     (async/sleep 1) (async/cancel p)
     (list (async/cancelled? p)
           (try (async/await p) (catch e (:type e)))
           (async/cancelled? p))))'
```

Observed: `#t` for the first, `(#f :cancelled #t)` for the second. Defensible
if `async/cancel` is specified as a request, but the two timings are
observably inconsistent, and user code that checks `cancelled?` right after
`cancel` will behave differently depending on scheduling. The fuzzer works
around it: cancel productions read `async/cancelled?` only after awaiting the
cancelled promise (post-settle reads are deterministic for every wait kind:
timer, channel recv, channel send, offloaded blocking sleep).

## 3. State-dependent runtime invariant fault: "registered promise wait became invalid: Unknown"

**Status:** found by the fuzzer (async mode, depth 6). Deterministic.
**Suspected area:** promise wait registration/reaping in the unified runtime
(`crates/sema-vm/src/runtime/`); interaction between leftover detached tasks
and a later eval in the same root task.

```bash
SEMA_FUZZ_ASYNC=1 SEMA_FUZZ_SEED=200000 SEMA_FUZZ_COUNT=51 SEMA_FUZZ_DEPTH=6 \
  ./target/debug/sema fuzz/grammar-fuzz.sema
# => Error: Eval error: runtime fault: Invariant { message: "registered promise wait became invalid: Unknown" }
# breadcrumb: 200050 (3/3 runs identical)
```

What is established (all deterministic, 3/3 runs):

- The faulting eval is P(200050) — a close/drain channel pipeline whose sender
  task starts with an offloaded `(sleep 0)` and contains nested `async/all`
  fan-ins (emit it with `SEMA_FUZZ_MODE=emit SEMA_FUZZ_SEED=200050
  SEMA_FUZZ_COUNT=1 SEMA_FUZZ_DEPTH=6`, plus the async gate).
- P(200050) alone does not fault (`SEMA_FUZZ_SEED=200050 SEMA_FUZZ_COUNT=1`
  passes). The fault needs earlier iterations in the same process.
- Seed 200001 is necessary: base 200001 faults, base 200002 does not. P(200001)
  is a spawn tree that leaves THREE detached children behind
  (`(async (async/sleep 0..3) 0)`, never awaited) — the deliberate
  leftover-state production.
- The intermediate iterations also matter: running only P(200001) then
  P(200050) via `eval` inside one root does not fault, and neither does
  concatenating all 51 programs as top-level forms (each top-level form is its
  own drive cycle). Only the fuzzer's shape — 51 `eval`s inside ONE root task,
  interleaved with per-iteration breadcrumb `file/write` — reproduces so far.
- The error is NOT catchable: the oracle wraps every eval in `try`, and the
  fault still aborted the whole fuzzer process (exit 1 mid-iteration). By
  design or not, an invariant fault ends the root. The driver now classifies
  this as ABORT (crash-class, exit 2) via the breadcrumb, since a plain exit 1
  is otherwise indistinguishable from a controlled mismatch run.

This matches bug shape 1 from the plan (orphaned/leftover pending state
corrupting later work in the same runtime) even under native `drive()`.

**Second instance** (independent seed range, same fault message,
deterministic):

```bash
SEMA_FUZZ_ASYNC=1 SEMA_FUZZ_SEED=500150 SEMA_FUZZ_COUNT=48 SEMA_FUZZ_DEPTH=6 \
  ./target/debug/sema fuzz/grammar-fuzz.sema
# aborts evaluating seed 500197
```

P(500197) is a different shape from P(200050): a `<=` comparison whose operand
contains the always-on capacity-64 channel fan-in nested in ordinary code. So
the trigger is not one production; any async-using eval can hit the fault once
the leftover state exists. Frequency at depth 6: 2 aborts in ~3500 seeds.
Depth 4 batches (thousands of seeds) have not hit it.

## Batch log

| Date | Commit stage | Seeds | Depth | Result |
| --- | --- | --- | --- | --- |
| 2026-07-29 | channel family | 5000..5199 (200) | 4 | PASS |
| 2026-07-29 | + spawn/cancel/owned | 9000..9199 (200) | 4 | PASS |
| 2026-07-29 | + race/timeout/causal | 13000..13199 (200) | 4 | PASS |
| 2026-07-29 | + offload leaves | 17000..17199 (200) | 4 | PASS |
| 2026-07-29 | all families | 100000..101999 (2000) | 4 | PASS |
| 2026-07-29 | all families | 200000..200999 (1000) | 6 | ABORT at 200050 (finding 3) |
| 2026-07-29 | all families | 300000..300499 (500) | 6 | PASS |
| 2026-07-29 | all families | 400000..400499 (500) | 6 | PASS |
| 2026-07-29 | all families | 500000..500499 (500) | 6 | ABORT at 500197 (finding 3, second instance) |
| 2026-07-30 | all families, final verification | 700000..700499 (500) | 4 | PASS (watchdog active, 6 s) |

## Resolutions (phase 2, 2026-07-30)

### Finding 3 — FIXED (commit `f70321bd`)

**Root cause** (`crates/sema-vm/src/runtime/state.rs`): a registered
promise-set wait (`async/await`/`all`/`race`/`timeout`) holds its members as
raw `PromiseId`s, invisible to the cycle collector. Once a member settles,
`PromiseRegistry::settle` consumes that member's waiter entry, so the
registry's "no waiters" eviction guard (`PromiseRegistry::gc_evict`,
`crates/sema-vm/src/runtime/promise.rs:189`) no longer saw the wait's
interest. If the member's handle was a temporary (nothing else kept the
`Value` alive), the collector's dead-handle candidate prune
(`crates/sema-core/src/cycle.rs`, `evict_dead_registry_record`) evicted the
settled record while the wait was still parked. The wait's next re-poll —
`consume_promise_wake` → `promise_set_response`
(`crates/sema-vm/src/runtime/state.rs`) — then hit `RegistryError::Unknown`
and raised the uncatchable `RuntimeFault::Invariant`.

The state-dependence decodes fully: the detached spawn tree (P(200001)) and
async load supply allocation churn so a GC pass lands while a later eval's
`async/all` is parked with an already-settled temporary member. Minimal
repro (deterministic, no fuzzer state — faulted 3/3 pre-fix):

```sema
(let ((ch (channel/new 1)))
  (let ((slow (async (channel/recv ch))))
    (async (async/sleep 10) (gc/collect) (channel/send ch 2))
    (async/all (list (async 1) slow))))
```

**Fix**: `RuntimeState::gc_evict_promise` defers the eviction of any id a
registered `Promises` wait still lists (the collector prunes a dead handle's
candidate exactly once, so the runtime owns the retry);
`teardown_promise_set_wait` replays the deferred eviction at all four
`Promises`-wait teardown sites (completion, timeout deadline, cancellation,
deadlock deregistration) once no registered wait references the id. The
invariant itself is sound and stays.

**Test**:
`vm_async_test::gc_pass_while_promise_set_wait_parked_keeps_settled_members_resolvable`.
Both repro recipes (200000×51, 500150×48) and the batches below now pass.

### Finding 1 — FIXED (commit `290b0dba`)

The blocking `sleep` worker now parks on a condvar bounded by the sleep
deadline (`SleepWake` in `crates/sema-stdlib/src/system.rs`) instead of an
uninterruptible `std::thread::sleep`; `SleepCancelHook::cancel`/`reap`
signal it. A cancelled blocking sleep releases its worker immediately — no
pool exhaustion from dead workers, and interpreter shutdown's executor
drain no longer runs to its full 2 s deadline (the CLI repro exits in
~30 ms). Non-cancelled sleeps are unchanged (`wait_timeout` expires at the
same deadline). Test:
`vm_async_test::cancelled_blocking_sleep_releases_worker_and_shutdown_promptly`.
The generator's 1500 ms cancel-target cap is no longer load-bearing.

### Finding 2 — doc gap, not a bug (docs fixed)

`async/cancel` is deliberately a request (sticky cancellation observed at
settlement, UCR-1): a not-yet-started task has nothing to unwind and
settles synchronously, while a parked task settles when the runtime tears
its wait down on a later drive turn — settling it synchronously inside the
builtin would require running wait teardown re-entrantly mid-quantum,
against the staged-teardown design (`pending_cancel_waits`, the UCR-3
wake-in-flight guard). Post-settle reads are deterministic for every wait
kind (fuzzer-verified), so the model is coherent; only the docs were wrong:
`async-cancel.md` claimed `#t` means the promise "actually transitioned"
to `Cancelled`, which is false for the parked case (`#t` = request
recorded). Both entries
(`crates/sema-docs/entries/stdlib/concurrency/async-cancel.md`,
`async-cancelled-p.md`) now state the request model and the
await-then-read discipline. The website async docs
(`website/docs/stdlib/concurrency.md`, outside this task's file scope) should pick up
the same wording when next touched.

### Post-fix batch log

| Date | Commit stage | Seeds | Depth | Result |
| --- | --- | --- | --- | --- |
| 2026-07-30 | finding-3 fix | 200000..201999 (2000) | 6 | PASS |
| 2026-07-30 | finding-3 fix | 500000..500499 (500) | 6 | PASS |
| 2026-07-30 | finding-1 fix | 200000..200499 (500) | 6 | PASS |
| 2026-07-30 | phase 3 | 810000..810999 (1000) | 5 | PASS (watchdog + value + twin) |
| 2026-07-30 | phase 3 | 910000..910999 (1000) | 6 | PASS (watchdog + value + twin) |

## Phase 3 (2026-07-30): shutdown-leak harness — no findings

The Rust harness (`crates/sema/tests/fuzz_async_shutdown_test.rs`) asserts
zero live tasks, resource gates at baseline, and a clean `ShutdownReport`
after every generated program, in both drive modes (fresh interpreter per
seed on `drive()`; seed pairs on one interpreter under selection-scoped
`drive_roots` with an undriven gap and a timer probe). Runs, all clean:

| Seeds | Depth | Modes |
| --- | --- | --- |
| 0..99 (100) | 4 | both |
| 200000..200299 (300) | 6 | both |
| 500150..500549 (400) | 6 | both |
| 17161000..17161199 (200) | 5 | both |

One non-runtime issue surfaced while building the harness: emit mode printed
a bare-string program in display form (unquoted), so the emitted text did not
read back. Fixed in the fuzzer (`program->source`), not a runtime bug.
