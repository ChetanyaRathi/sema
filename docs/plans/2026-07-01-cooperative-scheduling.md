# Cooperative Scheduling & Async Concurrency (canonical)

**Status:** living design — the single source of truth for Sema's async /
cooperative-scheduling model. Consolidates and supersedes:

- `archive/2026-06-23-async-agent-parallelization.md` — the generic `AwaitIo`
  cooperative-yield foundation + the leaf-conversion roadmap (Phase 1 shipped).
- `archive/2026-06-23-concurrent-complete-and-true-cancel.md` — concurrent
  `llm/complete|classify|extract` + the true-cancellation abort seam.
- `archive/2026-06-23-async-debugger.md` — cooperative stop/resume (breakpoints /
  stepping) through the scheduler.

Those files are retained (archived) for their detailed change logs and
verification addenda; this doc is what to read first and extend.

> **Framing (2026-07-01):** the scheduler is a **language-level** capability, not
> a feature of any one subsystem. Every blocking operation — LLM calls,
> subprocess/`shell`, `http/*`, file I/O, and eventually interactive input — and
> every consumer — parallel batch LLM, workflows, responsive TUIs, cancellable
> operations, the debugger — is a facet of the *same* model: a single-threaded
> `Rc` VM whose tasks cooperatively yield so siblings run while one waits.

---

## 1. The model

Sema has a real cooperative scheduler (`sema-vm` `scheduler.rs`). `async/spawn`
gives each task its own VM; `run_until_reentrant` round-robins ready tasks,
parking them on `YieldReason::{AwaitPromise, ChannelRecv, ChannelSend, Sleep,
AwaitIo}` (`async_signal.rs`). The VM is single-threaded and `Rc`-based by design
(no `Arc`/`Send` in the value graph), so **concurrency is interleaving, not
parallelism of Sema code**: exactly one task runs Sema at a time; blocking work
is offloaded to a shared OS runtime and the task *yields* while it runs.

### The generic yield mechanism (`AwaitIo`) — SHIPPED

The one primitive everything builds on:

1. A native that would block instead offloads the blocking unit onto the shared
   runtime (`stdlib_shared_rt()` in `async_rt.rs`) via `spawn` / `spawn_blocking`,
   publishing an `IoHandle` (with an optional abort seam).
2. It parks the task on `YieldReason::AwaitIo(Rc<IoHandle>)`; the scheduler steps
   other ready tasks. The park advances `virtual_now` by real elapsed, bounded by
   the nearest sleeper/timeout deadline and capped at ~50 ms for interrupt
   cadence, so sleepers and `async/timeout` stay live while I/O is in flight.
3. The worker calls `notify_io_complete()`; the scheduler resumes the bytecode
   *after* the call via `replace_stack_top` — **the native is not re-invoked**.
   Therefore all post-call work (span finalize, cache store, cassette record,
   `track_usage`, decode → `Value`) runs in the poller, on the VM thread.

`shell_async` (`sema-stdlib/src/system.rs`) is the canonical worked example
(offload + `AwaitIo` + abort + poller decode).

## 2. What's shipped (verified)

- **`AwaitIo` mechanism** + park/wake, sleeper/timeout liveness during I/O.
- **Blocking leaves converted**, gated on `in_async_context()` (sync path
  byte-identical): `http/*`, `shell`/subprocess, `llm/embed`, and the file I/O
  leaves `file/read`, `file/read-bytes`, `file/read-lines`, `file/write`,
  `file/append`, `file/copy`, `file/delete` (`fs_offload` in
  `sema-stdlib/src/io.rs`; `io_spawn_blocking` tier, no abort hook — a file op
  is bounded, cancellation discards the result; small-file async overhead
  measured at ~2.3x / +13 µs per 1 KB read, release build).
- **Bounded fan-out** `async/pool-map` (semaphore = capacity-N channel).
- **Concurrent `llm/complete` / `classify` / `extract`** via an `io_spawn`ed
  `run_fallback_retry_async` over per-provider `complete_future` hooks — same
  retry / `DROP_TEMPERATURE` self-heal / serving-provider semantics with zero
  drift. `do_complete_async_yield` (`sema-llm/src/builtins.rs`) is the reusable
  single-completion-with-yield.
- **Per-task OTel** context swap on task-switch + detached span carried in the
  `IoHandle` poller (so concurrent LLM spans don't cross-contaminate).
- **True cancellation seam** on `IoHandle`: real abort for all `spawn`-based
  offloads — socket for `http`, `killpg` for `shell`, dropped in-flight request
  for the LLM wire stage; best-effort only for sync-only providers on the
  blocking-tier fallback (`complete_future` default impl).
- **Cooperative debugging**: breakpoints + stepping inside async tasks, task-correct
  stack/scope inspection and step-depth, through the scheduler (native DAP + WASM).

## 3. The remaining generic work

The model is proven for **single-shot, offloaded leaves**. The open frontier is
**multi-step operations whose control loop currently lives inside one blocking
native** — the archetype is `agent/run`, but the shape is general (any native
that loops over multiple offloadable steps holding state across them).

### 3a. Non-blocking multi-round `agent/run` — SHIPPED (ADR #68)

**Done** (`docs/plans/2026-07-02-nonblocking-agent-run.md`, ADR #68). In an async
scheduler task, `agent/run` (and `llm/chat`-with-tools) now yields `AwaitIo` per
provider round, so siblings overlap during the conversation and `async/timeout`
cuts the loop at an inter-round park. The sync/top-level and `wasm32` paths keep the
byte-identical blocking `run_tool_loop` (renamed `__agent-run-blocking`).

The "yield-internally in one native" sketch below was **rejected during design**: a
native cannot loop-yield (a yielded `AwaitIo` is not re-invoked, and a poller cannot
arm a second yield or run async tools). The shipped design is the **step
decomposition** — a thin Sema/prelude driver (`__agent-drive`) over four internal
natives (`__agent-begin/step/exec-tools/finish`) backed by a Rust-owned, task-scoped
`AgentRunState` slab; each round reuses `do_complete_async_yield`; tools run in
ordinary task context; the agent OTel span is kept attached on the per-task otel
stack (carried by the existing `ReinstallGuard` swap, ended idempotently, including a
`tls_alive`-guarded `Drop` for the cancelled-run leak). Verified by
`crates/sema/tests/agent_async_test.rs` + `agent_async_breaker_test.rs`.

Original two-mechanism framing (kept for the record):

- **Yield-internally:** convert the native's round loop to offload each step via
  `do_complete_async_yield`, keeping RAII state inside one Rust frame. *Rejected — a
  native cannot loop-yield.*
- **Decompose to a step primitive** (SHIPPED): a non-blocking step native, loop in
  Sema. More flexible (Sema owns history/cancel); tool execution moves to the task
  layer; the invariants below are preserved in the Rust-owned handle.

**Status update (2026-07-12):** the paragraph above was written when only
`agent/run` had actually shipped the dispatcher — `llm/chat` with `:tools`
still called the blocking `run_tool_loop` unconditionally, silently
reintroducing the same sibling-freezing loop for a multi-round tool
conversation. That gap is now closed: `llm/chat` is a prelude dispatcher over
the identical `__agent-begin/step/exec-tools/finish` machinery (a new
`__chat-begin` native adapts raw messages/opts into an `AgentLoopState`, and
`__agent-finish` returns the bare completion string `llm/chat` promises
instead of the agent `{:response …}` envelope; the synchronous/no-tools entry
point is `__llm-chat-blocking`). The workflow `step` macro's `:tools` branch
needed no changes — it already just calls `llm/chat`, so it is non-blocking
transitively. See the CHANGELOG `## Unreleased` entry for the rest of that
sweep (which also closed `llm/batch`/`llm/rerank`, the remaining single-shot
LLM entry points, `sleep`/`retry`, `llm/with-rate-limit`, `git/*`,
`proc/pty` wait, `db/*`, `stream/*`, `kv/*`, archive/pdf/patch, and guarded
`http/serve`).

**Invariants either mechanism must keep** (learned the hard way):
- `track_usage` fires exactly once per round, in the poller/finalize, so the
  cache-hit-zero-usage accounting invariant holds.
- Tool-call correlation round-trips: assistant `tool_calls` and tool-result
  `tool_call_id`/name must survive any `:messages` serialization (a re-sent turn
  with a tool call otherwise fails provider validation).
- The agent OTel span parents all rounds; if the loop moves to Sema it must be
  held by a Rust object kept alive across steps (or keep the loop in one native).
- Errors return partial history for retry/inspection rather than dropping it.

### 3b. Independent rendering / responsive UI

For a UI to animate while a turn runs, run the turn and a render loop as two
`async/spawn`'d tasks. The scheduler steps **all** ready tasks, so a sibling
render task (`draw` + `async/sleep`) animates during any `AwaitIo` park — this is
the only structure that animates during both first-token waits and yielding-tool
waits. `event/select` is a convenience for input multiplexing, not a
prerequisite; note that a `select` loop calling a tool inline **suspends itself**
until the tool settles (nested blocking inline-task scheduler), so cancel-a-tool
requires spawning the tool as a task and racing it, not an inline call.

### 3c. Async input

`io/read-key-timeout` is a blocking OS poll with no yield — polling it in any
loop freezes every sibling task for the timeout. Needs an offload+yield
`io/read-key-async`, or a dedicated input task polling with a sub-frame budget
and `async/sleep` between polls. **New runtime work, on the critical path for any
interactive event loop.**

**Status update (2026-07-12): SHIPPED (PR #99).** `io/read-key-timeout`'s
async-context path now offloads via the generic `AwaitIo` yield instead of a
blocking OS poll, armed the same way the file/http/shell leaves are — no
separate `io/read-key-async` or dedicated input task was needed. See
`await_io_until` (`sema-stdlib/src/io.rs:608-642`) and the regression coverage
at `crates/sema/tests/vm_async_test.rs:1514`.

### 3d. `event/select` (optional convenience)

A stdlib selector over `:key` / `:timer` / `:proc` / task sources, built on the
async-aware leaves above. Nice for single-loop apps; keep it off the critical
path for animation (which needs only `async/spawn` + `async/sleep`).

**Status update (2026-07-12): SHIPPED (PR #99).** `event/select` now yields
`AwaitIo` in async context via the same `await_io_until` helper
(`sema-stdlib/src/io.rs:608-642`) instead of blocking the scheduler thread for
the whole timeout — a task selecting on a source that never fires no longer
stalls its siblings. Regression coverage: `crates/sema/tests/vm_async_test.rs:1514`.

## 4. Hard constraints & honest limits

- **Single-threaded `Rc` VM:** no `Send` in the value graph; only offloaded
  blocking work (I/O, LLM, subprocess, `async/sleep`) lets siblings run.
- **No preemption of synchronous Sema code:** a `deftool`/user function that does
  blocking work *without* yielding still freezes every task. This bounds what
  "responsive" can mean — CPU-bound or blocking-syscall Sema code is not
  interruptible.
- **RAII locals drop on yield:** a native's locals (e.g. an OTel span guard) are
  gone when it yields; per-task state must live in the `Task` or a Value-wrapped
  handle finalized on resume, not a native frame local.
- **HOF/tool-callback yielding:** in async context a callback routes through
  `run_closure_as_inline_task`, which *is* yield-aware but runs a **nested
  blocking** scheduler until it settles — the caller's frame does not interleave
  during it (only *other* spawned tasks do). On the synchronous path
  (`run_nested_closure`) a yield is a hard error.
- **Cancellation is tiered:** deterministic (real abort) for every `spawn`-based
  offload — `shell`, `http`, and the LLM wire stage; best-effort only where work
  bottoms out in a blocking closure (sync-only providers via the
  `complete_future` default impl).

## 5. Roadmap (folds the sub-plans' open items)

- **M1 — non-blocking `agent/run`: SHIPPED (ADR #68).** Delivered via step
  decomposition (Sema driver + `__agent-begin/step/exec-tools/finish` over a
  Rust-owned handle), not the yield-internally sketch (which is impossible — a
  native cannot loop-yield). See §3a and `docs/plans/2026-07-02-nonblocking-agent-run.md`.
- **M2 — async input:** `io/read-key-async` (offload+yield) or the sub-frame
  input-task pattern; quantify residual per-poll block.

  **Status update (2026-07-12): SHIPPED (PR #99).** Delivered via the
  offload+yield pattern, not a separate `io/read-key-async` entry point — see
  §3c and `sema-stdlib/src/io.rs:608-642` /
  `crates/sema/tests/vm_async_test.rs:1514`.
- **M3 — cancellation completeness:** race a spawned turn against interrupt; wire
  the abort seam end-to-end; document the LLM-tier best-effort split.
- **M4 — `event/select`** (convenience): multiplex `:key`/`:timer`/task; document
  the inline-tool suspension.

  **Status update (2026-07-12): SHIPPED (PR #99).** See §3d and
  `sema-stdlib/src/io.rs:608-642` / `crates/sema/tests/vm_async_test.rs:1514`.
- **M5 — workflows on top:** `workflow/foreach |parallel` and `async/pool-map`
  ride the same leaves; confirm no starvation under fan-out.

Each milestone: deterministic FakeProvider tests + a headless event-loop harness
(spawn a timer-driven counter task beside a delayed FakeProvider turn; assert the
counter advanced during the wait → proves independent interleaving).

## 6. Reference map (where things live)

- Scheduler / park-wake: `sema-vm/src/scheduler.rs`, `async_signal.rs`.
- Shared runtime: `sema-stdlib/src/async_rt.rs`; offload example:
  `sema-stdlib/src/system.rs` (`shell_async`).
- `AwaitIo` / `IoHandle`: `sema-core` (handle + abort seam), `sema-vm` (wake arm,
  park-on-IO branch).
- LLM async: `sema-llm/src/builtins.rs` (`do_complete_async_yield`,
  `run_tool_loop`, `agent/run`, `__chat-begin`/`llm/chat`).
- Checkout-pattern offloads (registry-held/stateful handles, not stateless
  leaves): `sema-stdlib/src/proc.rs` / `pty.rs` (`proc/wait`/`pty/wait`),
  `sqlite.rs` (`db/*`), `stream.rs` (file-backed `stream/*`), `kv.rs` (the
  `kv/set`/`kv/delete` flush) — each has an `Available`/`CheckedOut`/
  `Tombstone` slot and its own module doc comment explaining the pattern.
- Input: `sema-stdlib/src/io.rs` (`io/read-key*`, `unix_stdin_ready`).
