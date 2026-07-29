# Async grammar-fuzzer findings (phase 1)

Findings from building and running the async fuzzing mode
(`SEMA_FUZZ_ASYNC=1`, plan `docs/plans/2026-07-29-async-grammar-fuzzer.md`).
Phase 1 records findings; it does not fix the runtime. Each entry has a
reproduction that needs no fuzzer state.

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

## Batch log

| Date | Commit stage | Seeds | Depth | Result |
| --- | --- | --- | --- | --- |
| 2026-07-29 | channel family | 5000..5199 (200) | 4 | PASS |
| 2026-07-29 | + spawn/cancel/owned | 9000..9199 (200) | 4 | PASS |
| 2026-07-29 | + race/timeout/causal | 13000..13199 (200) | 4 | PASS |
| 2026-07-29 | + offload leaves | 17000..17199 (200) | 4 | PASS |
