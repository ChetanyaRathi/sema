# Deferred — resolved, closed and decided-against

Items that were once on `docs/deferred.md` and are now finished, killed, or
deliberately not being done. Split out on 2026-07-27 so the active list is only
work that could still be picked up — a backlog that mixes shipped work with open
work stops being read.

Nothing here needs action. It is kept because the *reasoning* is often the
valuable part: why a perf idea was spiked and discarded, why a feature was
killed, what a migration actually closed. Each entry keeps its original text and
resolution note.

For the open list see [`deferred.md`](deferred.md).

---

## ASYNC-DEBUG-1 — Async debugging under the unified runtime (cooperative-debug mode) — RESOLVED

**Found 2026-07-15, during the promise-op structural-ABI migration (Step D2), extended by the channel-op migration (Step D3). RESOLVED by P3-B1/B2 (debug moved onto the unified runtime).** The promise ops (`async/spawn`, `async/await`, `async/all`/`race`/`timeout`, the predicates, `async/cancel`, `async/run`) **and** the channel ops (`channel/new`, `send`, `recv`, `try-recv`, `close`, `closed?`, `count`, `empty?`, `full?`) are **runtime-only**: they suspend structurally through the `NativeOutcome` ABI (`Suspend`/`Runtime`) and are driven by the unified cooperative runtime.

The original deferral was that the legacy debug scheduler (native DAP + WASM cooperative debugger) could not execute these runtime-only async ops, so async breakpoints hit the "requires runtime invocation" stub. That is now fixed: the DAP and WASM debug drivers run *on* the unified runtime — a debugged program drives its VM via `drive_vm_on_runtime` under an `ActiveDebugGuard`, which pauses a runtime task at a breakpoint (`DriveState::DebugStopped` → `Stopped`), inspects its VM frames, and resumes it through the runtime's drive loop. The previously `#[ignore]`d tests are **re-enabled and passing**:
- `crates/sema/tests/dap_async_breakpoint_test.rs`: `async_task_breakpoint_stops_and_continues`, `async_task_breakpoint_inspects_task_frame_locals`.
- `crates/sema/tests/wasm_async_debug_test.rs`: `coop_async_task_breakpoint_stops_and_continues`, `coop_async_two_tasks_breakpoint_stops_at_known_line`, `coop_async_breakpoint_in_first_task`, `coop_async_step_over_and_out_use_task_depth`, `coop_async_stop_inspects_paused_task_locals`, `coop_abandoned_async_session_does_not_poison_next_session`, `coop_breakpoint_in_hof_callback_in_async_task_completes`.

**Residual (still deferred):** cross-task/cross-sibling stepping — stepping Into/Over/Out does not follow control *across* the scheduler boundary into sibling tasks or back to the main VM (B3). That distinct gap is tracked under **ASYNC-2** below; the STOP + CONTINUE + inspect slice on the runtime is complete.

## N5 — `server.rs` response-helper `.unwrap()`s — FIXED (2026-07-27)

**Today:** `crates/sema-stdlib/src/server.rs` lines ~1028-1099 (as of 2026-06-09) unwrap on `as_map_rc()` / `__stream_handler` / `__ws_handler` after a single-marker `is_*_response` check. A user who constructs a partially-formed response map (sets `__file_path` flag but forgets `__stream_handler`) panics the HTTP server thread.

**Proposed fix:** convert each unwrap to `.ok_or_else(|| SemaError::eval("..."))?` and propagate via `Result<ServerResponse, SemaError>` — sending a `ServerResponse::Error` over the oneshot instead of panicking.

**Why deferred:** the helper functions return `()` today; restructuring to propagate errors via the existing `oneshot::Sender<ServerResponse>` requires a new `ServerResponse::Error` variant and changes to the axum-side handler. Medium-effort refactor with non-trivial blast radius.

**Workaround today:** users normally build response maps with `http/ok`, `http/file`, etc. — those constructors always produce well-formed maps. The bug only triggers if a user builds a map by hand with the wrong `__*` markers. Low-likelihood in practice.

**Fixed 2026-07-27.** Reproduced first: a handler returning `{:__websocket true}`
panicked the server thread on the FIRST request (`called \`Option::unwrap()\` on a
\`None\` value`, server.rs:1854) and every later request got connection-refused —
so "low-likelihood" understated it, since one malformed response killed the
server for good, not just that request.

The fix needed no `ServerResponse::Error` variant after all: a malformed
response is naturally a 500, so all four sites (file, SSE, and both WebSocket
handlers) now send `ServerResponse::Raw` with status 500 and a body naming the
missing key — `handler returned a malformed websocket response: it is marked as
websocket but has no \`__ws_handler\`` — and the server keeps serving. Regression:
`server_test::test_malformed_marker_response_does_not_kill_the_server`.

---

## CORE-2 — recursive-closure Rc cycle (memory leak) — **FIXED (2026-07-02)**

**Was:** a self-referential closure formed an `Rc` cycle that reference counting couldn't
reclaim: a local/returned recursive closure captures its own name as an `UpvalueCell`
whose `Closed(Value)` holds the closure (shape U — measured 260 B leaked per churn
iteration). The design work found two more live shapes: every top-level define forms an
env⇄closure cycle that pins the whole global env at interpreter/notebook teardown
(shape E, ~168 KB per drop), and the `__vm-*` delegates strongly captured the very env
they were registered into (shape D, ~166 KB per drop with zero user code). The attempted
`Weak` captured-env fix had been dropped — it broke the "module exports a fn calling a
private helper" pattern (`vm_module_test`).

**Fix:** a synchronous Bacon–Rajan cycle collector over the existing `Rc` heap —
**ADR #66**, design/measurements/milestones in `docs/plans/2026-07-02-core2-gc.md`,
GC section in `docs/vm-status.md`. Creation-time candidate registry (VM closures, home
envs, the cold data constructors `delay`/promise/`channel`/`defmulti`), trial deletion
over a transient side map, reclamation by *severing* the one mutable cell every Sema
cycle must pass through. No headers, no `Value`/`Rc` changes, `Value::drop` untouched.
Shape D was fixed by refactor (delegates capture `Weak` — invariant I2 in AGENTS.md).
Perf gate passed (plan §6 M4): storm +0.91%, upvalue-counter +1.41%, fold −0.01%,
318 ns per reclaimed churn cycle. Oracles: `crates/sema/tests/leak_test.rs` (un-ignored),
the `gc_stress_test.rs` suite, the agent-turn FakeProvider test in `llm_fake_test.rs`,
and the notebook `reset_returns_old_kernel_memory` test.

---

## LC — Living Code LLM layers (`ask` / `heal!` / `evolve` / `observe!` / `become!`) — killed for good

**What it was:** layers 3–6 of the Living Code design (`docs/design/living-code.md`) — LLM-driven introspection (`ask`, `ask/code`, `ask/patch!`), auto-repair (`heal!`), genetic programming (`evolve`), and runtime self-modification (`observe!`, `become!`, `history`, `rollback!`, `freeze!`). Shipped on the tree-walker (PR #30, commits `248ebd8`/`fb0d7e6`/`69f1514`), then silently dropped when the tree-walker was retired in 1.18.0 — never ported to the VM, unbound at runtime, undiscovered for two releases.

**Why killed (not deferred):** (1) non-deterministic by construction — `evolve`/`heal!` emit a fresh LLM sample each run, so there is no regression test you can write, which is *exactly* how it rotted unnoticed; (2) `become!` (LLM rewrites a running function in place) carries a safety surface — doctest gates, sandboxes, rate limits, audit logs, freeze switches, rollback history — larger than the feature itself, a permanent tax on every VM/env change; (3) zero demand — no issue, no playground example, no website doc referenced it, and nobody noticed its disappearance.

**Salvage — also parked:** the whole feature is parked, nothing implemented. Only layer 0 (runtime docstrings `doc`/`meta`) was seriously considered, and a feasibility pass confirmed it's *clean* to build — the `Function` struct already carries serialized compile-time metadata (`source_file`, `local_scopes`), so a `doc` field rides the same path and the `.semac` string table (no source-text drag, binary path inherits it free). But with doctests + the LLM layers gone, `doc`/`meta` alone wasn't worth the standing maintenance (a `.semac` format-version bump + ~10 `Function` construction sites to carry forever), so it was **cut for maintainability** (2026-06-20) and parked as a clean plan to revisit later: `docs/plans/archive/2026-06-20-docstrings-and-introspection.md`. **Doctests (layer 1)** were dropped earlier as YAGNI. **Layer 2** (`read-source`/`source-of`/`;;@directives`) was scaffolding for the dead LLM layers — not salvaged either.

**Artifacts retired 2026-06-20:** PR #30 closed; `docs/plans/2026-02-24-living-code-phase4.md` archived; `docs/design/living-code.md` banner-marked RETIRED.

---

## P6 — `partition` / `frequencies` / `list/group-by` double-clone (perf, won't-do)

`crates/sema-stdlib/src/list.rs`. These clone each element twice (once for the callback args, once when pushing into the output bucket). Could be cut to one clone by consuming `items.iter().cloned()`.

**Why won't-do:** moved here from `docs/wip.md` on 2026-06-20. The earlier P1 work established that `Rc::clone` is too cheap to measure on these HOF-dispatch-bound paths; the same applies here. Revisit only if a profile actually fingers `partition`/`group-by` as a hotspot.

## P7 — `CALL_NATIVE` clones `Rc<NativeFn>` per call (perf, spiked → discarded)

`crates/sema-vm/src/vm.rs`, CALL_NATIVE handler: `let native = self.native_fns[native_id].clone();` — one `Rc` bump per native call, purely to release the borrow on `self.native_fns` so `self.stack` can also be borrowed.

**Spiked and discarded 2026-06-20.** Implemented the raw-pointer alternative (`Rc::as_ptr` + a minimal `unsafe` deref; the safety invariant holds — `native_fns` is built once at VM construction and never mutated during dispatch). It compiled, passed all tests + clippy, and was correct. But benchmarking before/after on `higher-order-fold`, `hashmap-bench`, and `string-pipeline` showed the delta entirely within noise (means < 1σ apart; the "winner" sign even flipped across workloads). A single non-atomic `Rc` bump on a single-threaded VM is free in practice. Adding `unsafe` to the hottest dispatch path — plus the standing burden of re-auditing the "never mutate `native_fns`" invariant on every future edit — for zero measured gain makes the codebase strictly worse. Not doing it. The only lever here is the `unsafe` one (a safe borrow-restructure is blocked by the re-entrant-HOF `&mut self` path), so this stays closed unless the call shape changes materially.

---

## TOOL-1 — Migrate the Makefile to a task runner ✅ RESOLVED (2026-07-06)

Done — migrated to [Jake](https://jakefile.dev) (`helgesverre/jake`, dogfooding our own
tool) rather than `just`. The `Makefile` is retired; build automation is the modular
`Jakefile` + `jake/*.jake` (grouped/namespaced recipes, params, `@needs` pre-flight,
`@confirm` on deploys, incremental `file` recipes). CI installs the jake release binary
and calls the recipes; the docs that referenced `make` targets were swept to `jake`.

## DOCS-SEARCH-1 — Domain-specialized tuning of the `docs_search` MCP tool

**Found 2026-06-25, after shipping `docs_search`.** The shipped tool is a generic-ish lexical BM25 ranker (recall@5 ≈ 0.93 on a keyword-ish oracle) but degrades on **vague, intent-only queries** where the user's words don't overlap the docs' words (~6/18 such queries missed: save→`file/write`, "each item"→`map`, scramble→`hash/sha256`). **Desired:** exploit that this engine is single-purpose over a fixed corpus known at build time — move expensive work (including a build-time LLM) offline and bake it, keeping the query path offline/deterministic and scratch-gate-safe. Highest-leverage levers: build-time document expansion (doc2query intent phrases/synonyms baked per entry), a popularity prior (we already computed per-symbol call-frequency), and a hybrid BM25 + pure-Rust static-embedding ranker — all measured against a baked gold-query eval harness. **Deferred because** the current tool is good enough to ship and the tuning is a multi-phase investment best done when conceptual-query quality demonstrably matters. Full plan: `docs/plans/2026-06-25-docs-search-tuning.md`.

---

## TYPED-ARRAY-1 — Typed arrays remain fixed-width by design (not a numeric-tower gap)

**Confirmed by design 2026-07-07.** The full numeric tower (ADR #70) adds arbitrary-precision
integers, exact rationals, and complex numbers to all general arithmetic and numeric builtins.
However, typed arrays (`TAG_I64_ARRAY` for `i64-array`, `TAG_F64_ARRAY` for `f64-array`) remain
fixed-width `i64`/`f64` containers **by design** — they are performance-oriented collection types,
analogous to SIMD vectors, intended for fast bulk operations on homogeneous in-range data.

**Semantics:** Storing a bignum, rational, or complex into a typed array either (a) narrows
the value (e.g., storing `1/3` into an `i64-array` truncates to `0`), or (b) raises a type
error, depending on the specific operation. This is intentional and consistent with the array's
fixed-footprint guarantee. The numeric tower is for general-purpose computation; typed arrays
are for performance-critical tight loops.

**Not a gap:** This is not a "no full numeric tower" limitation — the tower is complete for
all arithmetic, comparison, and numeric builtins. Typed arrays are an orthogonal performance
feature, not part of the numeric tower's scope. Applications needing arbitrary-precision
arithmetic use general lists or other dynamic collections; applications needing arrays use
typed arrays with appropriately-in-range inputs.

## MCP-4 — `mcp/call` blocks the cooperative scheduler (RESOLVED 2026-07-10)

**Found 2026-07-10 during the workflow `:mcp` work; resolved the same day**
(issue #96). All four MCP builtins (`mcp/connect`, `mcp/tools`, `mcp/call`,
`mcp/close`) — and every `mcp/tools->sema` wrapped handler, which routes
through the same shared call path — now offload their JSON-RPC round trip onto
the `sema-io` pool and yield `AwaitIo` when called inside an `async/spawn`'d
task, exactly like `llm/*`/`http/*`/`shell`. A slow `mcp/call` inside a
`parallel`/`pipeline` fan-out no longer stalls sibling tasks. The top-level
(non-async) path is untouched — same blocking semantics as before.

**How:** `crates/sema-mcp/src/builtins.rs`'s connection registry became
checkout-able (`Slot::Available`/`CheckedOut`/`Tombstone`, keyed off a stable
`ConnMeta` so tool-allowlist/cassette-identity checks don't need a checkout).
MCP is serial-per-connection by nature (one JSON-RPC pipe) — the checkout
enforces that per handle, while unrelated connections and non-MCP tasks
overlap freely. The offload closure body is genuinely the shared core: the
same `async fn`s the sync path drives via `sema_io::io_block_on` run,
unmodified, inside `sema_io::io_spawn_blocking` for the async path.

**Not a correctness bug for this feature:** the workflow `:mcp` auth-resolution
step (`docs/plans/2026-06-24-workflow-mcp-auth.md` §3) resolves declared
servers SEQUENTIALLY, before any concurrent fan-out starts — it never runs
inside a `parallel`/`pipeline` batch, so it is unaffected. Only a workflow body
that calls `mcp/call` concurrently (e.g. `(parallel (list (fn () (mcp/call …))
…))`) hits the stall, and only for the duration of that one call.

**A real bug found along the way, not just a stall:** the pre-existing sync
path drove every MCP operation on a private per-thread `TOKIO_RT` runtime.
Simply adding an offload path that drove the SAME connection's later calls via
the `sema-io` pool's *different* runtime instance hung forever — a
`tokio::process::Child`'s stdio pipes (and a `reqwest::Client`'s pooled
connections) are permanently bound to the runtime that created them, and can
never be polled to completion under a different one. The fix routes the sync
path through `sema_io::io_block_on` too (still a single blocking call on the
calling thread — no observable behavior change), so a connection made via a
synchronous `mcp/connect` and later called from inside `async/spawn` (the
common pattern, and exactly what the workflow `:mcp` pre-phase does) actually
works instead of parking indefinitely.

**Residual nuance, consciously left:** cancellation of an in-flight `mcp/call`
(`async/timeout`/`async/cancel`) is best-effort at the wire level — the
abandoned checkout tombstones the connection immediately (any further use
fails fast with a reconnect hint) but the background worker's own JSON-RPC
read keeps running until its own protocol timeout (120s) elapses, same policy
as the LLM completion offload's `spawn_blocking` tier. Acceptable: Sema-level
behavior (the task cancels, the handle is unusable) is correct and immediate;
only the underlying OS process/socket teardown is delayed. Pinned by
`crates/sema/tests/mcp_async_test.rs`.

## CANCEL-ROOT-CASCADE-1 — `cancel_root` does not sweep detached descendants (RESOLVED)

**Found 2026-07-18 (adversarial review of SRV-1); general runtime gap, not
SRV-1-specific. RESOLVED 2026-07-18.** `Runtime::cancel_root`
(`crates/sema-vm/src/runtime/state.rs`, the `cancel_root` fn) cancelled only the
root's main task and relied on the live cancellation-parent chain to reach
descendants — so a descendant that was still **parked** (awaiting/sleeping/
blocked) under the root got reaped, but a **fire-and-forget descendant of a task
that had already completed** was orphaned (its chain to the root was broken when
its parent settled and was removed from `state.tasks`). The `async/cancel` /
`CancelPromise` path did NOT have this gap — it calls `cancel_descendants`
explicitly. Empirically (persistent `Interpreter`, `runtime_live_task_count`
after `cancel_root`), pre-fix:

| shape | reaped? |
| --- | --- |
| root awaits `(async/spawn (sleep))` | **leaked (count 1)** |
| root detaches `(async/spawn (sleep))`, root sleeps | **leaked (count 1)** |
| `http/serve` handler awaits a grandchild | reaped (0) |
| `http/serve` handler detaches a child then returns | **leaked (count 1)** |

**Blast radius:** persistent multi-root hosts only (notebook cell cancel;
embedded `Interpreter`; a server that cancels one root while others run).
Process-exit CLI is unaffected (the process teardown reaps everything). SIGINT
of a single-root CLI program is unaffected (root settles, process exits).

**Resolution — `origin_root` sweep, not `cancel_descendants`.** The obvious fix
(have `cancel_root` call `cancel_descendants` on the root's main task, mirroring
`CancelPromise`) does NOT work: `cancel_descendants` is a BFS over the LIVE
`cancellation_parent` chain, the exact same chain that breaks when an
intermediate spawner settles and is removed from `state.tasks` — calling it from
`cancel_root` would still miss the orphaned grandchild for the identical reason.
Instead, `cancel_root` now sweeps `state.tasks` for every task whose
`relations().origin_root` equals the cancelled root — a field copied onto every
descendant at spawn time (`spawn_via_registry`) that survives an intermediate
spawner's removal, unlike `cancellation_parent`, which points at a specific,
possibly now-gone, task. The main task keeps the caller's `CancelReason`; every
other swept task gets `CancelReason::Owner` (matching `cancel_descendants`'
convention for a transitively-cancelled task). Each newly-cancelled task —
main and descendants alike — is pushed onto `pending_cancel_waits` and gets the
same C2 eager wait teardown `deliver_cancel_teardown` already provides for the
`CancelPromise` path; this composes exactly-once with the per-drive-turn
`cancel_waiting` scan because `deliver_cancel_teardown` removes the wait
registration itself, so the scan finds nothing left to double-abort.

**Tests** (`crates/sema-vm/src/runtime/tests.rs`, low-level `Runtime` host API,
no subprocesses): `cancel_root_reaps_a_fire_and_forget_grandchild_of_an_already_
settled_task` (the headline repro — a grandchild cancellation-parented to a task
id that was never inserted into `state.tasks`, modeling "already settled and
reaped"), `cancel_root_reaps_a_plain_single_task_root` /
`cancel_root_reaps_a_directly_parked_sibling_child` /
`cancel_root_on_a_settled_root_returns_false` /
`cancel_root_is_idempotent_second_call_returns_false_no_panic` (regressions on
the already-working shapes and the unchanged false/idempotent contract),
`cancel_root_sweep_does_not_reach_a_sibling_roots_tasks` (CRITICAL multi-root
isolation — cancelling root A must not touch root B's still-live detached task,
proven with a far-future `Timer` wait that cannot resolve on its own regardless
of how long the test keeps driving root A to settlement), and
`cancel_root_sweep_aborts_an_external_grandchild_exactly_once` (double-teardown
safety — a `RecordingHook`-backed External wait's abort hook fires exactly once,
not re-aborted by the drive-turn scan). A gotcha the test suite surfaced: the
`Inline` fake test executor resolves an External wait on its own after a few
drive turns regardless of cancellation, so a "descendant survives many drive
turns" assertion needs a Timer-based wait (never fires without an explicit clock
advance) to stay a valid RED/GREEN oracle — an External-based version of the
same test silently passed even with the sweep disabled, because the wait
resolved naturally before ever being cancelled.

## Unified runtime migration — deferred

**Context (updated 2026-07-16, post-P5 purge).** Every eval entry point drives
the unified cooperative `Runtime` — the sole async engine for CLI, MCP,
notebook, REPL, DAP, wasm, and tests. The legacy thread-local scheduler is
DELETED (P5, commit a1862f67); `scripts/check-unified-runtime-legacy.sh
--check` enforces zero reintroduction.

- **RESOLVED (2026-07-17, Step G — callback re-entry).** Both remaining
  Step-G gaps (nested `eval` of an async form, and multimethod dispatch of a
  suspending method) are fixed by giving each a runtime-ABI path that returns
  `NativeOutcome::Call`, so the runtime hosts the callee's suspension exactly
  like a HOF callback (`MapContinuation` et al.). The synchronous value-ABI
  paths are byte-for-byte unchanged: a bare top-level `eval`, a nested
  synchronous re-entry, and a multimethod call outside a runtime quantum all
  keep their exact prior behavior.

  **Nested `eval`.** `__vm-eval` (`crates/sema-eval/src/eval.rs`,
  `register_vm_delegates`) became a dual-ABI native
  (`NativeFn::with_ctx_runtime`): the legacy `func` is untouched (macro-expand,
  compile, run on a fresh throwaway `VM::execute`); the new `runtime` closure
  does the SAME macro-expansion + compile synchronously (both need
  `EvalContext`, which `NativeFn::invoke_runtime` only ever forwards to the
  legacy fallback — never to a `runtime_func`, so expansion/compile cannot move
  into the runtime closure itself), then wraps the compiled chunk as a callable
  `Value` via a new `sema_vm::program_as_callable(prog, home)` and returns it as
  one `NativeOutcome::Call` with a trivial forwarding continuation
  (`EvalProgramContinuation`). `program_as_callable` concretizes
  `compile_program`'s main closure — normally `globals: None`/`functions: None`
  ("run me on whichever VM owns me", since it's always driven directly by
  `VM::execute`) — into a real `MakeClosure`-shaped closure with a concrete home
  env, mirroring the wrapper `VM::make_closure` builds for an ordinary user
  closure, INCLUDING re-running the cache-offset assignment loop `VM::new`
  normally does for a freshly loaded program (skipping it would alias the
  eval'd program's inline-cache slots with a nested closure's inside it). Once
  wrapped, `invoke_vm_callback_loop`'s existing VM-closure extraction
  (`extract_vm_closure`) picks it up for free — no new runtime-loop code was
  needed. `register_vm_delegates` now also takes `ctx: &Rc<EvalContext>` (all
  three call sites — `sema-eval`'s two `Interpreter` constructors and
  `sema/src/lib.rs`'s builder — now `Rc::new(ctx)` BEFORE calling it) so the
  runtime closure can capture `Weak<EvalContext>` (invariant I2: `EvalContext`
  transitively owns `Value`s via its module/user-context caches, so the capture
  must be weak, upgraded per call, exactly like the existing `Weak<Env>`
  pattern in the same function).

  **Multimethod dispatch.** The direct-call sites in the VM
  (`crates/sema-vm/src/vm.rs`, `call_value`/`call_value_with`'s non-native,
  non-keyword fallback, `tail_call_value` delegates to `call_value`) used to
  always call `sema_core::call_callback` synchronously — the only channel
  `call_value`'s callback signature offers, which cannot express a suspension.
  Both sites now share a new `call_non_native` helper: when a runtime quantum
  is active AND the callee is a multimethod, it resolves the SELECTED method
  (still synchronously — the dispatch function itself is a plain selector, not
  expected to suspend, mirroring `apply`'s cooperative gate, which never routes
  a multimethod's dispatch function through the Call ABI either) via a new
  shared `sema_core::resolve_multimethod_handler(ctx, mm, args)` (factored out
  of `sema-eval`'s `call_multimethod`, which now calls it too — one dispatch
  algorithm, not two), then stashes a `NativeOutcome::Call` to the handler
  (`MultimethodCallContinuation`, a trivial forwarder) via the SAME
  `stash_native_dispatch` a native's runtime dispatch uses, so the opcode loop
  (`Op::CALL`/`Op::TAIL_CALL`) picks it up as a structural pending outcome with
  no new opcode-level plumbing. Outside a runtime quantum, or for any other
  non-native callable, `call_non_native` falls back to the exact prior
  synchronous `call_callback` path.

  A multimethod can also enter the structural Call ABI directly through a
  runtime native such as `apply`, without passing through `call_non_native`.
  `Runtime::invoke_callable` resolves that case with the same shared helper,
  snapshots a dispatch closure that crosses from the parked caller VM, and
  recursively invokes the selected handler under the original continuation.

  Verified working: `(eval '(async/await (async (+ 40 2))))` → 42 (was: "no
  async scheduler registered"); `(eval '(+ 1 2))` unaffected at top level and
  inside a runtime quantum; `(map (fn (x) (eval x)) '((+ 1 1) (+ 2 2)))` →
  `(2 4)`; a direct multimethod call whose selected method does
  `(async/await (async/spawn ...))` suspends and resumes cleanly, while a
  sibling synchronous method on the same multimethod is unchanged. `(apply mm
  ...)` now uses the same cooperative dispatcher, so a suspending selected
  method parks and resumes normally. Gate tests:
  `vm_eval_is_vm_native_runs_async` (`crates/sema/tests/vm_integration_test.rs`,
  un-`#[ignore]`d) and
  `multimethod_selected_method_suspends_cooperatively`
  plus `apply_of_suspending_multimethod_runs_cooperatively`
  (`crates/sema/tests/vm_async_test.rs`), and
  `native_call_multimethod_dispatches_selected_suspending_handler`
  (`crates/sema-vm/src/runtime/tests.rs`).

  The indented diagnosis below is retained as historical evidence only. Every
  “remaining” or failing statement in that block is superseded by the
  resolution and passing gates above.

  **`vm_eval_is_vm_native_runs_async`** (`crates/sema/tests/vm_integration_test.rs`).
  `(eval '(await (async (+ 40 2))))` fails with "no async scheduler registered".
  Root cause: the nested-`eval` callback (`eval_value_vm` in
  `crates/sema-eval/src/eval.rs`) runs the eval'd form on a FRESH `VM::execute`
  without a runtime quantum, so an async op inside it looks for the legacy
  scheduler (no longer initialized on the main path) instead of the unified
  runtime. Making nested `eval` run its forms re-entrantly under the SAME
  runtime requires the parent-VM parking / callback re-entry machinery
  (`NativeOutcome::Call` for eval) — that is **Step G (legacy callback re-entry
  migration)**. Restore this test there.

  **Scope narrowed (2026-07-16, callback-re-entry cooperative fix).** The other
  callback-driving builtins that previously leaked the same value-ABI
  "internal error: runtime native function 'X' requires runtime invocation"
  stub when handed a runtime-only op — `apply`, `call-with-values`, and
  multi-list `map` — now route a runtime-only-native callee through the
  structural `NativeOutcome::Call` continuation ABI (like single-list `map`/
  `filter`/`foldl`/`sort-by`/`for-each`), so it SUSPENDS cleanly. `apply` and
  `call-with-values` gate on `NativeFn::is_runtime_only()`: only a genuinely
  runtime-only native (whose value ABI is the stub) takes the cooperative Call;
  every closure (async handled by `call_function`'s inline-task routing) and
  dual-ABI blocking native (e.g. `__llm-chat-blocking`, which owns task-scoped
  stream/agent slab state) keeps its exact prior synchronous path, so
  cancellation slab-reaping is unchanged. Multi-list `map` drives its callback
  through `MapMultiContinuation`. Verified WORKING: `(apply async/spawn (list
  (fn () 5)))` yields an awaitable promise; `(async/await (apply async/spawn
  (list (fn () 42))))` → 42; `(call-with-values (fn () 1) async/resolved)` yields
  a promise (producer runs synchronously, the runtime-only consumer suspends);
  `(map channel/send (list c) (list 5))` runs. Gate tests live in
  `crates/sema/tests/vm_async_test.rs` (`apply_*`, `call_with_values_*`,
  `map_multi_list_*`). The **remaining** Step-G surface is nested `eval` of an
  async form — `(eval '(async/await (async (+ 40 2))))` — which still needs the
  parent-VM parking machinery above; that is the primary case this deferral now
  covers.

  A second, independent Step-G-class gap: **multimethod dispatch of a method
  whose body suspends** leaks the same stub — `(mm x)` where `mm`'s selected
  method runs an async op fails with "requires runtime invocation" even in a
  direct call (not just via `apply`). Multimethod dispatch re-enters the
  evaluator synchronously (`call_callback`), which cannot host a suspend; making
  it cooperative needs dispatch to return `NativeOutcome::Call` to the method,
  the same machinery nested `eval` needs. Pre-existing; not apply-specific
  (`apply` correctly keeps multimethod callees on the synchronous path since the
  cooperative Call path does not dispatch multimethods anyway).
  One ungraceful sub-case remains: `(apply mm …)` where the SELECTED METHOD's
  body suspends leaks the raw "requires runtime invocation" stub (pre-existing;
  the graceful error covers only a runtime-only native as apply's direct
  callee).

- **RESOLVED (2026-07-16, Step F / F2 conversion — commits e6b7004b, 1cabd457).**
  `event_select_yields_to_sibling_in_async_context` is un-ignored and green.
  `event/select` yields before parking and uses structural `WaitKind::Timer`
  waits: one exact earliest-deadline wait for timer-only sources, or bounded
  5 ms VM-thread checks when key/process readiness is present.

### ASYNC-RUN-BARRIER-1 — `async/run` self-resolving-waits barrier (RESOLVED)

**Found 2026-07-15; RESOLVED 2026-07-16 (decision C1).** `(async/run)` was a ready-DRAIN
(`RuntimeRequest::OriginBarrier` parked the caller on a zero-duration `Timer`, so the
virtual-clock rule ran every ready sibling then released), NOT the specified transitive
settle-barrier. A descendant parked on a real timer (`async/sleep`) when the drain quiesced was
left pending — `(async/spawn (fn () (async/sleep 30) (println "bg"))) (async/run)` returned
before "bg" printed.

**Resolution — a self-resolving-waits barrier** (`Runtime::resolve_origin_barriers` /
`origin_barrier_released` in `crates/sema-vm/src/runtime/state.rs`). `(async/run)` parks on a
real `ProtocolWaitKind::OriginBarrier { root }` wait; the drive loop re-evaluates the release
predicate at the top of EVERY iteration (so on every origin-root settlement/park transition).
The barrier releases (caller resumes with nil) once no OTHER task sharing the caller's origin
root is Ready, Running, or parked on a **self-resolving** wait. Classification of the residual
graph:

| WaitKind (→ ProtocolWaitKind)                | class          | barrier |
|----------------------------------------------|----------------|---------|
| `Timer` (`Timer`)                            | self-resolving | WAITS   |
| `External` (no protocol entry; `WaitRuntime`)| self-resolving | WAITS   |
| `PromiseSet` **Timeout** (`Promises`)        | self-resolving | WAITS   |
| `Promise` / `PromiseSet` all·race (`Promises`)| cycle-forming | excludes|
| `Channel` (`Channel`)                        | cycle-forming  | excludes|
| `ResourceSlot` (`ResourceSlot`)              | cycle-forming  | excludes|
| nested `async/run` (`OriginBarrier`)         | cycle-forming  | excludes|

Transitivity is automatic: a self-resolving sleeper's awaiter becomes Ready when it fires, so
the re-checked barrier keeps waiting until that too settles. The repro now prints "bg" then
"after-run"; a transitively-spawned sleeper drains fully.

**Reviewer-2 hole, closed: `ResourceSlot` MUST be cycle-forming.** A slot holder that another
origin-root task waits on may itself be excluded (blocked on a channel the barrier caller would
service, a self-awaited parent). Classifying `ResourceSlot` as self-resolving would make the
barrier wait on a slot waiter whose grant never comes → hang. The hazard cases —
self-awaited parent, channel-rendezvous-blocked child, resource-slot-blocked child — are all
cycle-forming-parked and thus excluded, so the barrier is deadlock-free.

**Tests.** `crates/sema/tests/vm_async_test.rs`: `async_run_waits_for_timer_parked_descendant`
(the repro), `async_run_drains_transitively_spawned_sleeper`,
`async_run_releases_over_channel_rendezvous_blocked_child`,
`async_run_releases_under_self_awaiting_parent` — all out-of-process with a real wall-clock
kill (a barrier hang surfaces as `timed_out`). `crates/sema-vm/src/runtime/tests.rs`:
`async_run_barrier_releases_over_resource_slot_cycle` — a `ResourceSlot`-held-forever cycle,
guarded by a drive-turn bound (were `ResourceSlot` self-resolving the barrier would hang and the
guard would trip).

**DAP + wasm async debugging now run ON the unified runtime (P3-B1/B2).** The
DAP and WASM debug drivers (`crates/sema-dap`, `crates/sema-wasm`) drive a
debugged program's VM via `drive_vm_on_runtime` under an `ActiveDebugGuard`
(`DriveState::DebugStopped` → `Stopped`), so async breakpoints, Continue, and
frame inspection work against the runtime task's own VM frames — the legacy
`init_scheduler` + `VM::execute` async debug path is retired. See ASYNC-DEBUG-1
(RESOLVED) above. The one residual is cross-sibling stepping (ASYNC-2, B3):
stepping does not follow control across the scheduler boundary into sibling
tasks. SYNC debugging was always unaffected.

### F2-RESIDUAL — external I/O on the AwaitIo bridge (RESOLVED 2026-07-16)

**RESOLVED 2026-07-16.** All three sub-gaps closed and the AwaitIo bridge is
deleted (P2 "AwaitIo funeral", commit 04257fcd):
- **F2-RESIDUAL-1** — `ResourceGate` runtime primitive (`WaitKind::ResourceSlot`,
  FIFO acquire-queue) + the shared `checkout_external` helper; all six checkout
  modules (proc, sqlite, kv, serial, pty, stream) converted (commits e4399de3,
  0485e486, d385494e).
- **F2-RESIDUAL-2** — no streaming primitive was needed: `ws` restructured onto
  checkout + async-tier `recv` (commit 869366cd, per the P2 plan amendment).
- **F2-RESIDUAL-3** — the executor async tier is a real reactor
  (`ProcessIoExecutor`, tokio spawn + AbortHandle drop-on-cancel, P0 commit
  e530fc06); sema-llm's `interruptible_async` path runs on it.
The historical description below is retained for the record.

**Found 2026-07-15, Step F2.** The one-shot request/response I/O ops (file, http, git,
shell, sleep) are migrated to the canonical `WaitKind::External` on the ThreadPoolExecutor.
The remaining I/O subsystems still offload via the legacy `YieldReason::AwaitIo(IoHandle)`
thread-local (a VM-thread-polled tokio handle), because they do NOT fit the plan's one-shot
`WaitKind::External` primitive. Their async branch was re-gated to fire under the runtime
quantum (`in_async_context() || in_runtime_quantum()`), so async overlap works correctly under
the unified runtime today — only the *transport* is still the AwaitIo bridge. Three sub-gaps,
each needing a runtime primitive the plan does not define:

- **F2-RESIDUAL-1 (stateful checkout ops): proc, sqlite, kv, serial.** These keep a
  thread-local resource registry (`PROCS`/`DB_CONNECTIONS`/`PORTS`, non-`Send`) with a
  per-handle **checkout + Acquire-queue** (an async wait-for-availability under contention).
  `WaitKind::External` has no per-handle-availability primitive; dropping the queue would
  regress concurrent same-handle serialization. Needs a per-handle async mutex/availability
  wait, or a retry-in-continuation (a `NativeContinuation` may itself return `Suspend`).
- **F2-RESIDUAL-2 (streaming ops): ws, pty, stream.** Persistent connections / repeated reads
  with backpressure. A single `Result<T, String>` completion does not model a stream; needs a
  streaming External-wait shape (or per-read one-shot suspensions over an `Arc<Mutex<conn>>`).
- **F2-RESIDUAL-3 (sema-llm real-network + the executor async tier):** the executor's
  `ExecutorDispatch::Async` arm is reactor-less (sema-vm carries no tokio runtime by design), so
  `PreparedExternalOperation::interruptible_async` panics on a real future. The migrated ops use
  `interruptible_blocking` + `sema_io::io_block_on` (one worker per in-flight op — a concurrency
  ceiling). sema-llm's existing `interruptible_async` path has the SAME latent bug (only ever run
  with the keyless `FakeProvider`). Foundation fix: teach the Async tier to spawn on the shared
  io runtime (`io_spawn`) with drop-on-cancel; then all async I/O gets full concurrency + the true
  interruptible-async abort, and `runtime_offload` gains an `external_io_async` variant.

Until these landed, `AwaitIo`/`IoHandle`/`poll_io_waits`/`io_park`/`notify_io_complete` and the
`run_exprs_via_runtime` `legacy_io_wakeup` arm stayed — they were the runtime's I/O-offload
transport for the residual ops, driven by the runtime (NOT the legacy scheduler). P2 deleted them.

### ASYNC-TIMEOUT-CANCEL-1 — `async/timeout` does not promptly abort a spawned child's running External job (RESOLVED 2026-07-16)

**RESOLVED 2026-07-16 (decision C2, commit d385494e).** Cancellation recorded on
an External/IO-parked task now runs the wait teardown at request time
(deregister → abort hook once → cancelled settlement), so a sibling
`async/timeout` promptly aborts the child's in-flight executor job; the
drive-scan drain is a backstop only. The UCR-3 rendezvous-cancel value-drop was
fixed in the same pass.

**Found 2026-07-15.** `(async/timeout ms (async/spawn thunk))` where the thunk runs an External
I/O op: the timeout fires and returns the `:timeout` condition, but the child's in-flight
executor job's cancel/abort hook runs only at runtime-shutdown drain (and a one-shot `-e` leaks
the child by exiting first). The abort MECHANISM is correct — explicit `(async/cancel p)`
promptly reaps the child (killpg/AbortHandle fires within ~50ms) — the gap is that a SIBLING
timeout's cancellation is not delivered to the External-parked task promptly. This is inherent
to how the runtime delivers cancellation to a task parked on an External/IO wait (the legacy
AwaitIo path had the same `cancellation.is_some()` precondition); it is not introduced by the
F2 conversion. Fix: deliver a task's cancellation to its registered External/IO wait's
abort hook promptly when the task is cancelled by a sibling, not only at drain.

### LEGACY-SCHEDULER — purged (RESOLVED 2026-07-16, P5)

**RESOLVED 2026-07-16 (P5 purge, commit a1862f67; `YieldReason` fully retired
in a follow-up slice).** `scheduler.rs`, `LegacyPromise`/`LegacyChannel`,
`IN_ASYNC_CONTEXT`, `SchedulerTarget`/`SchedulerRunResult`/`DebugCoopResume`,
`COOP_TASK_STOP`, and the scheduler callback seams are deleted;
`scripts/check-unified-runtime-legacy.sh --check` (zero-tolerance, no globs)
guards against reintroduction. The last surviving piece of the old TLS yield
transport, `YieldReason` (a single variant `Sleep(u64)`), has since been
deleted too — along with `set_yield_signal`/`take_yield_signal` and
`VmExecResult::AsyncYield` — once investigation showed it could be retired
cleanly: `async/sleep`'s structural Timer ABI (`invoke_runtime`) is always
preferred when a `TaskContext` is installed, so the legacy value-ABI closure
is reached only when a caller bypasses `invoke_runtime` entirely — a raw
native passed directly to a single-ABI (`register_fn`-only) HOF like
`any`/`every`, or to `apply` — where there is no way to suspend anyway. That
closure now raises a clear "wrap it in a lambda" error itself instead of
setting a TLS signal for the VM to relay; outside any runtime quantum (a
nested/foreign synchronous VM re-entry) it still actually sleeps. The
`list.rs` guard (`check_hof_yield`) that used to detect the stale signal is
gone too — `call_function`/`call_function_owned` return the native's result
directly. `scripts/check-unified-runtime-legacy.sh` was extended with fixtures
for `YieldReason`, `set_yield_signal`, `take_yield_signal`, and
`VmExecResult::AsyncYield` to catch reintroduction.

What IS fully deleted and guarded against reintroduction (see the static-scan
test): the thread-local suspension transport for LANGUAGE async —
`YieldReason::NativeYield`, `PENDING_NATIVE_OUTCOME`, `set/take_pending_native_outcome`, the
ad-hoc `spawned_promises`/`promise_waits`/`channel_bridge` stores, `YieldReason` itself
(`Sleep` included) and its `VmExecResult::AsyncYield` carrier, and the runtime's
consumption of the promise/channel `YieldReason` variants (now structural `NativeOutcome`).
Promises, channels, and cooperative HOFs go 100% through the canonical registries + the
structural ABI with no thread-local suspension hop.

**Inventory reconciliation — RESOLVED (2026-07-16).** `runtime_conformance_test`'s
`unified_runtime_inventory_mapping_covers_exact_current_matches` (mapping in
`docs/plans/evidence/unified-cooperative-runtime/runtime-match-map.tsv`) drifted RED during the
migration (line shifts + the LegacyPromise/LegacyChannel split + the NativeYield/spawned_promises
deletions moved ~1000 sites). The map has been reconciled against post-purge source: 856
production matches, all classified into the ledger taxonomy (371 carried over by symbol-text
from the prior classification, 485 newly classified by symbol→owning-row), zero UNREVIEWED,
exact coverage, symbol clusters verified pure. `--check` is green and the test passes — the
final migration-completeness audit. (Coarse-but-faithful judgment calls flagged for future
refinement: the new `runtime/` module split across F23-F31, `runtime_offload.rs → F09B`, and
the crate-local `runtime_eval_tests` module → F31.) The
other two conformance guards ARE reconciled and green: `unified_runtime_legacy_symbols_match_
baseline` (baseline regenerated to the post-migration surface — confirms NativeYield/
PENDING_NATIVE_OUTCOME/spawned_promises/channel_bridge are gone and LegacyPromise/LegacyChannel
are the only new legacy cells) and `no_adhoc_tokio_runtimes_outside_allowlist` (the
interpreter's cooperative `Runtime::new` is allowlisted; in-src `tests.rs` modules are exempt
like `tests/**`).

### P6-3 WASM Promise-driven roots — RESOLVED 2026-07-17 (step 5, the deletion); P6-1 RESOLVED

**P6-3 step 5 (the deletion) — RESOLVED 2026-07-17.** Landed on top of steps 2-4
(the `evalPromise` seam, the root-aware worker protocol, and the real-browser
acceptance gate — transcript at
`docs/plans/evidence/unified-cooperative-runtime/p63-browser-gate-transcript.txt`).
Deleted: the three HTTP-replay loops in `evalAsync`/`evalVMAsync`/`runEntryAsync`
(now thin Promise-returning wrappers over `evalPromise`, preserving their JSON
shape and JS-visible signatures — see
`docs/plans/archive/2026-07-16-wasm-promise-driven-roots.md` §2.1); `MAX_REPLAYS`; and
the JS worker's dormant `legacySab`/control-`SharedArrayBuffer` fallback branch
(`playground/src/sema-worker.js`) entirely.

**Deliberately NOT deleted — two verified-live consumers found during the step-5
audit, kept rather than forced per the landing rule ("if something still reads
it, STOP and report"):**
1. `HTTP_AWAIT_MARKER`/`is_http_await_marker`/`parse_http_marker`/`HTTP_CACHE`/
   `clear_http_cache`/`perform_fetch_from_marker` — narrowed to the wasm
   debugger's own `http_needed`/`debugPerformFetch` flow
   (`crates/sema-wasm/src/lib.rs`'s `debugStart`/`debug_maybe_http_error`),
   which is not promise-driven and has no other way to surface a pending
   fetch to JS. Every other caller (the three rewritten entry points) now
   routes through `evalPromise`, where `http/get` never throws this marker at
   all (dual-ABI gate in `register_wasm_io`).
2. `SLEEP_I32`/`worker_atomics_sleep`/`worker_check_interrupt`/
   `installAtomicsSleep`/`set_blocking_sleep_callback`/`set_interrupt_callback`/
   `sema_core::check_interrupt` — `crates/sema-eval/src/eval.rs`'s
   `drive_handle_to_settlement` (wasm32 branch) still needs interruptible
   blocking sleep for every still-synchronous wasm entry point (`eval`/
   `evalGlobal`/`evalVM`, and a precompiled bytecode archive entry, which has
   no submit-a-root equivalent to route through the promise seam). A bare
   `(async/sleep ...)` reaches this branch on ANY path — `async/sleep` is not
   dual-ABI-gated the way `http/get` is — so this is not merely the old SAB-
   cancel path; forcing its deletion would break synchronous eval on wasm32
   with no replacement mechanism in scope for this step. With the worker's SAB
   allocation gone, this machinery degrades to the same no-op "busy-poll to
   deadline" the main thread has always used when no callback is installed —
   graceful, not broken, just less promptly cancellable mid-sleep for a
   synchronous call specifically.

A precompiled bytecode archive entry's `http/get` (no submit-a-root path
exists for a compiled chunk) now surfaces a clear, honest error instead of the
deleted replay loop leaking the internal HTTP marker string — the sanctioned
"sync fast path errors on suspension with a clear message" fallback.

Also fixed as a byproduct: `crates/sema/src/web/assets/sema_wasm.js`/
`sema_wasm_bg.wasm` (the `sema web` packaged runtime, embedded via `build.rs`)
were stale relative to even P6-3 step 2 (missing `evalPromise`/`cancelRoot`/
`setPromiseOutputSink` bindings entirely) — regenerated via
`jake wasm.web-runtime` and committed; `scripts/test-packaged-sema-web.sh`
passes against the rebuilt `.crate`.

Full record: `.superpowers/sdd/p63-step5-report.md`.

### DEBUG-PROMISE-DRIVE — debugger HTTP replay is still the pre-P6-3 marker/cache flow (follow-up, not attempted here)

**Recorded 2026-07-18**, while fixing a same-session cache-clobber bug in that
flow (`fix(wasm): debug HTTP cache survives same-session replay restart`,
`.superpowers/sdd/debug-fetch-loop-report.md`). The debugger's `debugStart` is
the one caller `HTTP_AWAIT_MARKER`/`HTTP_CACHE`/`debugPerformFetch` still
survive P6-3 step 5 for (§ above, "deliberately NOT deleted" item 1): a
synchronous drive that hits `http/get` throws the marker, JS awaits a real
fetch via `debugPerformFetch` (caching the response), then re-calls
`debugStart` to replay the whole program from scratch up through the
now-cached response(s). The P6-3 step-5 authors punted on unifying this with
the promise-driven `evalPromise` seam because "there is no way to surface a
pending fetch to JS from a synchronous drive" — the debug drive is
inherently synchronous (single-stepping/breakpoints need a paused VM state
JS can inspect between steps), and `evalPromise` roots run to completion (or
a yielded turn) without exposing that kind of mid-drive pause.

The real end state is to promise-drive the debug drive through the same
`evalPromise` seam the three rewritten entry points use, so `http/get`
suspends and resumes the *same* task in place instead of re-running the
program from the top — at which point the marker/`HTTP_CACHE`/
`debugPerformFetch`/restart machinery (and the replay-restart-vs-fresh-start
distinction the 2026-07-18 fix had to introduce, `DEBUG_HTTP_REPLAY_ARMED`)
can be deleted entirely, along with the non-idempotent-side-effects and
`MAX_DEBUG_HTTP_RETRIES` caveats that come with re-running a whole program on
every HTTP call during a debug session. This needs its own design pass (how a
promise-driven root exposes step/breakpoint/locals-inspection to JS between
turns) and is **not attempted here** — out of scope for the 2026-07-18 fix,
which only stopped the replay restart from wiping its own just-cached
response.

**P6-1 common host API — RESOLVED 2026-07-17** (commits 0b54e961..519fdc50):
public `Interpreter::{submit_str, submit_value, drive_until_settled, drive_turn,
take_output, command_handle, shutdown}`, `RootOptions` (`capture_output`;
`name` is a documented no-op extension point), root-tagged `OutputEvent`, and
`RuntimeCommandHandle` as the sole `Send + Sync` control surface (commands ride
the completion inbox; delivery at drive-turn start). Proving consumers: CLI
Ctrl-C (`cancel_all`, double-press hard-exit — see docs/limitations.md for the
long-synchronous-native caveat) and the notebook engine (per-cell capture +
cross-thread cell cancel via `CancelToken`). Both P6-1 and P6-3 are closed by
the resolutions above.

**Historical pre-landing attempt (superseded).** On 2026-07-16 the rewrite
fell back cleanly, before the Promise-driven implementation and browser gate
landed the next day. At that checkpoint the wasm host
(`crates/sema-wasm/src/lib.rs`) still ran the shipped **replay-with-cache** HTTP path
(`eval_async` re-runs the whole program up to `MAX_REPLAYS=50` on each `HTTP_AWAIT_MARKER`,
so non-idempotent side effects re-execute) and the `Atomics.wait`/SharedArrayBuffer sleep
(`installAtomicsSleep`/`worker_atomics_sleep`). The target (P6-3) is a Promise-returning
`eval()` driven on the unified `Runtime` across macrotask turns, with `fetch`/timers as
JS-callback-fed `WaitKind::External` completions (program body runs ONCE, no replay), deleting
the replay+Atomics machinery and routing cancel through `RuntimeCommandHandle::cancel_root`.

**Two coupled blockers recorded at that checkpoint:**
1. **P6-1 (common host API) was unimplemented** — `Interpreter::submit_str`/`submit_value`/
   `drive`/`cancel_root`/`command_handle`, `RuntimeCommandHandle` (the only `Send` surface),
   `RootOptions`, root-tagged `OutputEvent`. Only the low-level `Runtime::submit_root`/`drive`/
   `poll_result`/`cancel_root` and `Interpreter::drive_vm_on_runtime` exist. P6-3 builds on
   this surface; it must land first. (Note: `check_interrupt`/`set_interrupt_callback` is dead
   on native — only wasm's SAB-cancel uses it — so retiring that TLS is part of P6-3, not a
   separable native win.)
2. **Real-browser verification is the only valid oracle.** A Promise-driven rewrite can only
   be proven correct in a browser (http side effect fires exactly once; sleep via setTimeout
   keeps the page responsive; fair concurrent roots; exact-root Stop). Shipping an unverified
   rewrite of a working mechanism is prohibited. The design and a `test.fixme` Playwright gate
   are captured in `docs/plans/archive/2026-07-16-wasm-promise-driven-roots.md` and
   `playground/tests/unified-runtime.spec.ts` for a future landing by someone with a browser.

Pre-landing hard-audit items (flagged in the design doc): the External-HTTP resume binding a
decoded `Value` must carry a `Trace` impl (GC invariant I2); macrotask fairness between live
roots; cancel latency for a root suspended in an External wait; the worker-protocol rewrite
dropping the SAB; `MessageChannel` vs `setTimeout(0)` throttling in background tabs.

## PERF-RESIDUAL-1 — post-flip runtime overhead (RESOLVED 2026-07-24 — non-suspending HOF fast path; release gate lifted)

**RESOLVED 2026-07-24** by the non-suspending HOF direct-dispatch fast path
(`docs/plans/archive/2026-07-24-hof-nonsuspending-fast-path.md`;
`crates/sema-vm/src/hof_sync.rs`): when a HOF callback's call graph provably
cannot suspend (conservative bytecode scan, memoized per `Function`, keyed on
the env-chain version fingerprint), `map`/`filter`/`foldl`/`reduce`/`for-each`
run their element loop synchronously on a pooled scratch VM inside the parent
quantum — no drive round-trip per call, no continuation rebuild per element.
Suspending callbacks keep the cooperative path (analysis is conservative);
`context.rs` callback guards are untouched. Recovery, same protocol (hyperfine,
baseline binary rebuilt+verified at `3f111e83`):

| program | was (reopen) | now | note |
|---|---|---|---|
| `deriv` | 4.78× | **1.18×** | tiny nested maps, recursive global callback |
| `string-pipeline` | 3.92× | **1.12×** | inert-native callbacks (`string/to-number`, `+`) |
| `higher-order-fold` | 3.25× | **0.78× (faster)** | foldl/map/filter × 10k |
| flat 10M-element map | 3.47× | **0.75× (faster)** | micro |
| nested map | 3.90× | **0.72× (faster)** | micro |
| `tak`/`nqueens`/`closure-storm`/`throw-catch` | ≤1.06× | ≤1.05× | unchanged |
| `mandelbrot` / `hashmap-bench` | 1.15×/1.11× | 1.12×/1.09× | unchanged band |
| spawn/sleep-storm, deep-await, primes | — | 0.55–0.87× (faster) | async no-regress ✓ |
| channel-pingpong | ~1.4× accepted | 1.26× | within accepted end-state |

The reopened entry's analysis is preserved below for context.

**REOPENED 2026-07-24 (pre-merge-to-main A/B, candidate `e0e5acb8` vs baseline
`14c44309`).** The `jake bench` VM suite — which the branch's async-focused
hyperfine suite never covered — shows the allocator/GC-registry residual below
(cons-1m 1.38×) is NOT the mild tail it looked like; on allocation/HOF-heavy
compute it balloons to **3–5×**:

| jake bench program | baseline (min) | candidate (min) | ratio |
|---|---|---|---|
| `deriv` (symbolic diff, deep recursion) | 0.645 s | 3.081 s | **4.78×** |
| `string-pipeline` (source unchanged bar whitespace) | 0.541 s | 2.122 s | **3.92×** |
| `higher-order-fold` (foldl/map/filter × 10k list) | 0.535 s | 1.740 s | **3.25×** |
| `mandelbrot` / `hashmap-bench` | — | — | 1.15× / 1.11× |
| `tak` / `nqueens` / `closure-storm` / `throw-catch` | — | — | ≤1.06× (noise) |

Attribution is proven merge-innocent: the runtime hot-path code is identical
between the branch tip (`63b13180`) and the merge (only an error-path trace fix
+ test-only changes differ), the regressed programs are byte-identical, the
release profile is identical, and main did not diverge from the branch fork
point `3f111e83` on the VM/eval hot path (1 non-perf commit). `map` and `foldl`
dispatch through the same `NativeOutcome::Call` path at comparable per-element
cost, so this is NOT foldl-specific — it is the universal-flip's per-op
(instruction-accounting + cooperative dispatch + allocation/GC-registry)
overhead on programs that repeatedly build large lists, i.e. the cons-1m suspect
below at scale. **Owner decision (2026-07-24): merge lands on main now (clean +
green: 7221 tests, 81 examples), but this is a RELEASE GATE — no release until
the allocation-heavy path is diagnosed and recovered to an accepted band.**
Next: profile `deriv` + a foldl-over-10k microbench (samply + instruction
counts) to size the fix (targeted fast-path miss vs. fundamental flip cost).

---

**Recorded 2026-07-17 (Slice 0b close-out). Status update, same day: acceptance rescinded — owner redirected the program to a deeper optimization pass (Slice 0c) before P6-1: samply/sample profiling with full symbols, then divan/criterion micro-benchmarks instrumenting the cooperative scheduler, then targeted squeezes. This entry became the 0c work list; outcome: sleep-storm/deep-await/cons-1m
RESOLVED (0.88×/1.11×/1.03×), spawn-storm/primes faster-than-baseline.
The direct-handoff follow-up landed (0c-7, commit ffae33c1): channel-pingpong
is now ~1.4× (565M vs ~400M instructions) — the residual is diffuse per-quantum
overhead on the genuinely-parked half, with no single lever left. Recorded as
the accepted end-state of the squeeze pass.
Final tables + micro-benchmark reference: benchmark-vs-baseline.md.** The fast-path
recovery pass (clock batching, register-local instruction countdown, in-place
HOF dispatch, inline matched rendezvous, empty-scope seam-swap skip — commits
097f76e0..f165a767) brought HOF compute and spawn fan-out FASTER than the
pre-migration engine, but three shapes remain above the 1.10× bar vs baseline
`3f111e83` and are deliberately parked for a later optimization pass:

- **channel-pingpong 2.82×** (~19k instructions/message residual): the
  genuine-park half of a capacity-1 rendezvous still pays quantum park/unpark
  with `Box<VM>` moves and task-map churn. Follow-up: direct task-to-task
  handoff — write the peer's resume value without parking the matched sender.
- **sleep-storm 1.65× / deep-await ~1.7×**: per-task spawn+timer+settle
  lifecycle through the drive loop (~10 ms per 500 tasks absolute). spawn-storm
  (same machinery, no timers) beats baseline, so the residual is timer-wheel +
  park-path specific.
- **cons-1m 1.38×**: NOT explained by any 0b target (no HOF, no channels,
  budget check already register-local). Needs its own diagnosis; suspected
  allocator/GC-registry interaction under the runtime.

Reproduction protocol, corrected baselines, and per-task measurements:
`docs/plans/evidence/unified-cooperative-runtime/benchmark-vs-baseline.md`.
Benchmark binary-identity rule: rebuild and verify the baseline worktree binary
(`git log` + mtime) before measuring — a stale bisect-era binary contaminated
one investigation.

## PG-E2E-1 — two playground debugger defects — RESOLVED (2026-07-27)

**Recorded 2026-07-17; narrowed 2026-07-19.** The broad debugger red set was
mostly test-harness drift. `@sema-lang/ui` exposes current and breakpoint state
as the `cur` and `bp` classes on `[part~="gutter-line"]`; the shared helpers
incorrectly queried nonexistent `current` and `breakpoint` part tokens. After
aligning the helpers with the installed UI contract, 31 of the 33 focused
debugger tests pass. Two independent defects remain:

- The exchange-rates HTTP test reaches Ready and then clicks a hidden Stop
  button; its external response path and control flow need a dedicated repair.
- The infinite-loop debugger test receives `unsupported runtime VM stop:
  Yielded` instead of the expected step-limit termination.

**Resolved 2026-07-27 by the unified-runtime migration, not by direct repair.**
Both defects are gone and neither needed its own fix:

- The error string `unsupported runtime VM stop: Yielded` no longer exists
  anywhere in the tree — the code path that produced it was removed when the
  blocking compatibility paths were retired and the Promise-driven roots became
  the only mechanism.
- The exchange-rates HTTP control-flow defect no longer reproduces.

Verified by running the whole debugger set against a playground rebuilt at
1.31.5: `debugger`, `debugger-async`, `debugger-promise`,
`debugger-exchange-rates`, `debugger-http-single-execution` and
`debugger-perlin` — **43 passed, 0 failed**. (One run failed first on
`archive version mismatch: built with Sema 1.31.5, runtime is 1.31.4`, which was
a stale `playground/pkg` after the release bump, not a defect — rebuild the
playground after a version bump before trusting these specs.)

The release gates now build the final playground WASM and run the stable
runtime subset: `unified-runtime.spec.ts` and
`debugger-http-single-execution.spec.ts` (13
tests). The two remaining debugger defects are excluded from that focused gate
until repaired; the full playground suite remains the local acceptance suite.

## C1 follow-up — caught-HOF-callback errors lack a stack trace

**Today:** after the C1 fix (HOF callbacks routed into the running VM), one residual symptom of wrapping a VM closure as a `NativeFn` remains: a VM error caught from inside a HOF callback lacks a `:stack-trace`. (The sibling `(type (fn …))` → `:native-fn` artifact was fixed 2026-06-19 via the `NativeFn::is_closure` marker — see VM-2 above, now resolved.)

**Why deferred (decided 2026-06-18):** cosmetic / low-impact; it stems from the closure-as-NativeFn boundary, not from upvalue timing (which C1 fixed). Tied to VM-1 (stack traces). Revisit if it bites real usage.

**RESOLVED — verified 2026-07-27.** The symptom no longer reproduces: errors
caught from inside a HOF callback now carry a populated `:stack-trace` with
frames, for explicit `(error …)` and for genuine runtime faults alike.

    (try (map (fn (x) (+ x "nope")) (list 1))
      (catch e (get e :stack-trace)))
    ;=> ({:col 19 :line 1 :name "+"} {:col 19 :line 1 :name "<lambda>"})

    (try (filter (fn (x) (undefined-thing x)) (list 1))
      (catch e (get e :stack-trace)))
    ;=> ({:col 22 :line 1 :name "<lambda>"})

Closed by the VM stack-trace work it was tied to (VM-1), not by a fix aimed at
this boundary.

---

