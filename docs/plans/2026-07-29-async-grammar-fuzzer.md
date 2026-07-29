# Async grammar fuzzer — plan

Extend the in-Sema grammar fuzzer (`fuzz/grammar-fuzz.sema`) to generate and
check async programs. Today the fuzzer deliberately excludes almost the entire
async surface ("no stable value oracle"). The unified runtime's bug history
shows that is exactly where the untested bugs live.

## Current state

What the fuzzer generates today:

- Well-typed, closed programs over int/bool/float/string/list/vector/map,
  plus metamorphic laws and a round-trip datum generator.
- Exactly three async productions, all chosen to be trivially deterministic:
  `gen-int-asyncsum` (`async/all` over `(async T)` tasks, summed),
  `gen-list-asyncall` (`async/all` preserves spawn order), and
  `gen-int-asyncchan` (channel fan-in summed order-independently, capacity 64
  so `channel/send` never blocks).
- Explicitly excluded (header comment): `async/sleep`, `async/timeout`,
  `async/race`, cancellation.

What the fuzzer never touches, per the stdlib surface (`async_ops.rs`,
`prelude.rs`, `system.rs`):

- Blocking channel ops: small-capacity channels where `channel/send` parks,
  `channel/recv` on an empty channel, `channel/try-recv`, `channel/close`
  waking parked senders/receivers.
- Timers: `async/sleep`, blocking interruptible `sleep`, `async/timeout`.
- Cancellation: `async/cancel`, `async/cancelled?`, cancel-during-park,
  cancel-during-offload (the `CancelHook` paths in `runtime_offload.rs` and
  `SleepCancelHook` in `system.rs`).
- Select-like: `async/race`.
- The owned prelude combinators: `async/spawn-all`, `async/map`,
  `async/pool-map` (channel-backed semaphore), `async/race-owned`,
  `async/with-timeout` — fail-fast settlement plus a cancel sweep
  (`__owned-all` / `__cancel-all`).
- Offloaded I/O leaves (file ops through the executor's blocking tier).
- Detached tasks that outlive their root, and `drive_roots`-scoped driving
  (native always drives with `drive()`; wasm32 is the only production host on
  `drive_roots`, per `drive_runtime_root` in `crates/sema-eval/src/eval.rs`).

Oracles today: printer/reader round-trip, generation-time value oracle,
metamorphic laws, and hard-crash detection via a seed breadcrumb file
(`scripts/grammar-fuzz.sh`, exit codes 0/1/2). There is no hang detection: an
in-process `(eval form)` that never settles hangs the whole fuzzer run.

No CI runs the grammar fuzzer at all. `nightly.yml` currently carries
test-windows, docs-search-gate, and coverage.

## Bug shapes to bias toward (from history)

1. **Orphaned pending stages wedging the runtime under `drive_roots`**
   (v1.31.1, CHANGELOG; memory note `orphan-pending-stage-stalls-timers`). A
   `state.pending` item reachable from no selection — an empty `ChannelClose`
   with no waiters, `fire_timer`'s runtime-wide gate plus unfiltered
   `pop_due` — stalled every later timer. Native `drive()` masks the entire
   class. The fuzzer must be able to run generated programs under
   selection-scoped driving, with multiple sequential roots on one runtime and
   leftover detached state between them.
2. **Park-vs-pin regressions** (`docs/bugs/2026-07-28-sibling-interleaving-tests-are-load-sensitive.md`).
   The load-safe oracle shape is established there: causal ordering (a
   zero-delay sibling observed before/after a parking root) and lower bounds
   are trustworthy; wall-clock upper bounds are not. Generate causal-ordering
   programs; never assert an upper bound on elapsed time.
3. **Cancellation leaks and dropped continuations** (MCP subprocess leak on
   cancel; `RuntimeRequest::Spawn`'s parked-VM fast path silently discarding
   non-trivial continuations, CHANGELOG). Cancel tasks parked in every wait
   kind (timer, channel send, channel recv, offloaded blocking op), then check
   the survivor's value, the `async/cancelled?` predicate, and — in phase 3 —
   that nothing stays live (`runtime_live_task_count() == 0`, resource gates
   back to baseline, `ShutdownReport.clean`).

## Hard constraints carried over from the existing fuzzer

- **Single-integer-seed reproducibility.** Iteration *i* seeds the PRNG with
  `base + i`; every finding must reproduce with
  `SEMA_FUZZ_SEED=<s> SEMA_FUZZ_COUNT=1` (plus `SEMA_FUZZ_ASYNC=1`). The
  breadcrumb-file mechanism already gives this for crashes; hangs reuse it.
- **Confluence by construction.** Every generated program's value must be
  independent of interleaving. Allowed shapes: order-independent reductions
  (sum, multiset), deterministic winners (exactly one non-parked candidate),
  value-neutral effects (a sleep, a cancelled loser), and causal orderings
  that are race-free per the sibling-interleaving analysis. `set!` stays
  excluded for the same referential-transparency reason as today.
- **Termination by construction.** Every program terminates on a correct
  runtime: sends and recvs are balanced (or the imbalance is resolved by a
  cancel or close the generator also emits), sleeps are ≤ 5 ms, channel
  capacities are 1–3 (small enough to force parking, never enough to deadlock
  a balanced program), pool-map worker counts are 1–4 over ≤ 8 items. The
  watchdog is a net for runtime bugs, not a crutch for generator bugs.

## Phase 1 — generator extension + no-hang oracle

### Generator (in `fuzz/grammar-fuzz.sema`)

Gate all new productions behind `SEMA_FUZZ_ASYNC=1` so the existing fast
deterministic sweep is unchanged. New productions, each returning `(mk form
expected)` as today:

- **Spawn trees.** Nested `async/spawn` of int programs, awaited via
  `async/await` and `async/all`, depths 1–3, occasionally detached
  (spawned, never awaited, body value-neutral) to seed leftover state.
- **Blocking channel pipelines.** `channel/new` with capacity 1–3; k senders,
  k recvs, order-independent reduction (sum). Variants: recv-before-send (the
  receiver parks first), send-into-full (senders park), producer sends k then
  `channel/close`, consumer drains exactly k then checks
  `(channel/closed? ch)` → `#t` law. `channel/try-recv` only after all sends
  have been awaited (deterministic hit) or on a fresh channel (deterministic
  miss).
- **Sleeps.** `(async/sleep 0..5)` inserted at random points in task bodies.
  Value-neutral, so no oracle change. Also the blocking `sleep` inside a
  spawned task (parks via the interruptible-resource path).
- **Cancellation.** Spawn a task parked forever (recv on a never-sent
  channel, or `async/sleep 86400000`-capped-large — use 60000 ms), then
  `async/cancel` it; laws: `(async/cancelled? p)` → `#t`, and awaiting it
  inside `try` yields the cancellation error (caught, mapped to a marker
  int). The surviving computation's value is the oracle value. Cancel each
  wait kind: timer, channel recv, channel send (full channel), blocking
  `sleep`.
- **Select-like.** `async/race` / `async/race-owned` over one immediate task
  and 1–3 forever-parked tasks — the winner is deterministic by construction.
  `async/with-timeout` where the body either completes immediately (value
  wins) or parks forever (timeout error wins, caught in `try`).
- **Structured concurrency.** `async/pool-map` (n = 1–4) and
  `async/spawn-all` / `async/map` over pure worker functions; a failure
  variant where exactly one worker throws — the owned combinator cancels the
  siblings; expected is the caught error marker. This exercises the semaphore
  channel and the `__cancel-all` sweep.
- **Causal ordering (park-vs-pin).** Root parks (`async/sleep 5` or a recv);
  a zero-delay sibling sends a marker to an output channel; root sends its
  marker after resuming; drain the channel and assert sibling-before-root.
  Race-free per the sibling-interleaving write-up. No timed variant, no
  wall-clock bounds.
- **Offload leaves.** Inside tasks: `file/write` then `file/read` of a
  per-seed file under a temp dir (deterministic content is the value), to put
  External waits and their cancel hooks in play. Include a cancel-during-
  offload variant (cancel a task parked in blocking `sleep` — deterministic;
  file-op cancellation timing is racy, so cancel only tasks whose offload has
  a park the generator controls).

### No-hang oracle (in `scripts/grammar-fuzz.sh`)

The watchdog must be external to the runtime under test: an in-program
`async/timeout` rides the same timer wheel whose wedging is bug shape 1.

- Check mode with `SEMA_FUZZ_ASYNC=1` runs seeds in batches of K (default
  100) per subprocess. The existing breadcrumb file records the in-flight
  seed before each iteration, unchanged.
- The driver starts each batch in the background and enforces a deadline of
  `K × per-program-budget` (budget default 5 s — generous; generated sleeps
  are milliseconds; only a lower bound on progress, never "fast"). On
  expiry it kills the process group, reads the breadcrumb, reports the seed
  as a HANG finding with the standard repro line, and exits 3.
- Exit codes become: 0 pass, 1 mismatch, 2 crash, 3 hang.

### Jake (in `jake/fuzz.jake`)

- `jake fuzz.async n=5000 depth=4 seed=` → `grammar-fuzz.sh check --async`.
- `jake fuzz.async-emit n=10` for sampling generated async programs.

### Files

- `fuzz/grammar-fuzz.sema` — new productions, `SEMA_FUZZ_ASYNC` gate.
- `scripts/grammar-fuzz.sh` — batching, watchdog, exit code 3, `--async`.
- `jake/fuzz.jake` — two recipes.
- `fuzz/README.md` — document the mode, the confluence rules, exit code 3.

### Size

~450 lines of Sema, ~90 lines of bash, ~20 lines of jake/docs. 2–3 days
including shaking out generator termination bugs.

## Phase 2 — confluent-value oracle

Phase 1 already gives every production a generation-time expected value (the
house pattern: compute bottom-up while generating). Phase 2 adds an
independent sequential twin so a bug in the generation-time model itself
cannot self-mask, mirroring how the laws back up the value oracle:

- For the mechanically de-asyncable productions — spawn trees, `async/all`,
  `async/spawn-all`, `async/map`, `async/pool-map` (success path) — derive a
  twin form: `(async/spawn f)` + await → direct call; `async/all` over
  spawns → `list` of the bodies; pool-map → `map`. Eval both forms; they
  must agree, and both must equal the generation-time expected value.
- Channel pipelines, cancellation, race, and timeout keep the generation-time
  model only (their twins are not mechanical), plus `#t` laws
  (`cancelled?`, `closed?`, race-winner identity).
- Record the confluence class per production in a comment table so future
  productions state which oracle covers them.

### Files

- `fuzz/grammar-fuzz.sema` — twin derivation (a walker over the generated
  form) + the extra check in `check-oracle`.
- `fuzz/README.md` — oracle table.

### Size

~200 lines of Sema. 1–2 days.

## Phase 3 — shutdown-leak oracle + nightly wiring

### Shutdown-leak oracle

The introspection needed is Rust-side only: `Interpreter::
runtime_live_task_count()`, `runtime_resource_gate_count()` (both in
`crates/sema-eval/src/eval.rs`), and `Interpreter::shutdown(ShutdownOptions)
-> ShutdownReport` with `clean`, `live_tasks`, `active_waits`,
`retained_cleanup`, `invariant_failures`
(`crates/sema-vm/src/runtime/host_api.rs`). None of it is a Sema builtin, so
this oracle lives in a Rust harness, not in the `.sema` fuzzer:

- New integration test `crates/sema/tests/fuzz_async_shutdown_test.rs`
  (nightly-scoped: `#[ignore]` by default, run explicitly by the nightly job
  and a jake recipe; seed base and count from `SEMA_FUZZ_SEED` /
  `SEMA_FUZZ_COUNT` env). Per seed it:
  1. Generates the program by running the release/debug `sema` binary in
     `SEMA_FUZZ_MODE=emit SEMA_FUZZ_ASYNC=1 SEMA_FUZZ_COUNT=1` (repo-relative
     paths are fine in tests).
  2. Evals it on a fresh `Interpreter`, then asserts
     `runtime_live_task_count() == 0` — detached tasks must have been reaped
     by settlement or teardown — and the resource-gate count is back to its
     pre-eval baseline.
  3. Calls `shutdown` with a bounded deadline and asserts `report.clean` and
     `report.invariant_failures.is_empty()`.
- **`drive_roots` mode (targets bug shape 1 directly).** The same harness
  runs seed pairs (A, B) on one shared interpreter, driving each root with
  the selection-scoped seam (`Interpreter::drive_roots`,
  `crates/sema-eval/src/eval.rs`) instead of the default `drive()` path, with
  a short undriven wall-clock gap between A settling and B being submitted —
  the exact reproduction recipe from the v1.31.1 investigation. B always
  contains an `async/sleep`, so a timer wedged by A's leftover state hangs B
  and the test's own timeout catches it. If submitting a root without driving
  it needs a small public seam, add it next to `drive_roots` rather than
  reaching into `sema-vm` internals.
- If `sema::Sema` (`crates/sema/src/lib.rs`) lacks a `resource_gate_count`
  wrapper, add it beside the existing `runtime_live_task_count` wrapper.

### Nightly wiring (`.github/workflows/nightly.yml`)

One new job, `grammar-fuzz`:

- Build the release binary (reuse `.github/actions/setup-sema` + cache).
- Run the existing deterministic sweep, currently in no CI at all:
  `./scripts/grammar-fuzz.sh check -n 20000`.
- Run the async mode: `./scripts/grammar-fuzz.sh check --async -n 5000`.
- Run the shutdown harness over a bounded range:
  `SEMA_FUZZ_COUNT=500 cargo nextest run -p sema-lang --run-ignored
  ignored-only fuzz_async_shutdown`.
- Seeds: random per run, printed in the log (the scripts already print
  seed/count at startup), so any red night carries its reproducing seeds. No
  `continue-on-error`: a red job is the signal, same policy as test-windows.
- Budget: sized to stay under ~25 minutes total; tune n downward if the
  release build dominates.

Jake: `jake fuzz.async-shutdown n=500` wrapping the nextest invocation for
long local runs.

### Files

- `crates/sema/tests/fuzz_async_shutdown_test.rs` — new.
- `crates/sema/src/lib.rs` — gate-count wrapper if missing.
- `crates/sema-eval/src/eval.rs` — only if a submit-without-drive seam is
  needed for the paired-roots mode.
- `.github/workflows/nightly.yml` — the job.
- `jake/fuzz.jake`, `fuzz/README.md` — recipe + docs.

### Size

~300 lines of Rust, ~40 lines of YAML, ~20 lines jake/docs. 1–2 days; the
paired-roots `drive_roots` mode is the risky half.

## Out of scope

- Network-dependent async (http, ws, LLM providers) — no deterministic
  oracle without a server; the FakeProvider suites cover the LLM loop.
- Wall-clock upper bounds of any kind (the sibling-interleaving lesson).
- Fuzzing `sema-workflow` — separate runtime, separate journal oracle;
  revisit after this lands.
- Shrinking beyond the existing depth-lowering advice. Single-seed repro plus
  small depths has been enough to hand-minimize findings so far.
