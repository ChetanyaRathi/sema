# Deferred items

> **Resolved items live in [`deferred-resolved.md`](plans/archive/deferred-resolved.md).** This
> file is only work that could still be picked up; anything finished, killed, or
> decided-against was split out on 2026-07-27.


Things that came out of the May 2026 quality sweep (Wave 6 audit) but were intentionally not fixed because they're too risky, too design-dependent, or have a cheap workaround. Each entry says *why* it's deferred so a future pass can decide whether to revisit.

## MCP-1 — Named/aliased MCP servers

**Found 2026-07-01, during the MCP client PR (#59).** Every `mcp/connect` and `sema mcp login/logout` repeats the full server config (`:url`/`:command`). A convenience layer would let you declare a server once — a `name → {:url …}`/`{:command …}` mapping (in a script or a small config file) — and refer to it by name (`(mcp/connect "asana")`, `sema mcp login asana`). Pairs naturally with the token store, which already keys by canonical URL. **Deferred because** it's a pure ergonomics feature with a design choice (script-level form vs. a config file), orthogonal to the client's correctness, and best done after the base client lands.

## MCP-2 — `sema mcp list`

**Found 2026-07-01 (PR #59).** No CLI command surfaces which remote servers have cached credentials or their token status. A `sema mcp list` would show authenticated/known servers (and, ideally, which script or config declared each — which depends on MCP-1). **Deferred because** it's additive tooling; the "which script declared it" part needs the alias registry from MCP-1 first.

## MCP-3 — Fully-offline agent replay (cassette `tools/list` + `connect` skip)

**Found 2026-07-01 (PR #59, M5 cassettes).** MCP `tools/call` results record/replay through the shared cassette, so agent tool *calls* replay offline. But `mcp/connect` (and its `initialize`/`tools/list`) still runs live on replay, so a fully server-less agent-session replay isn't possible yet — you still need the stdio server or the HTTP endpoint reachable to establish the connection and enumerate tools. Extending the cassette to record `tools/list` and short-circuit `connect` on replay would close this. **Deferred because** the common case (deterministic *call* replay for CI) is covered; connect/list recording is a larger seam (identity keying for the handshake, and for remote servers the OAuth/discovery legs) that isn't needed for the value M5 delivers.

Also noted from the PR #59 merge review as low-priority, not-yet-done: capping the device-flow `slow_down` interval growth (the `+5` itself is RFC 8628-correct), and auto-reconnecting a Streamable-HTTP session on a mid-session `404` (currently surfaced as a `reconnect required` error rather than transparently re-initializing).

## ASYNC-2 — Stepping across the scheduler boundary into sibling async tasks

**Found 2026-06-23; residual of the async-breakpoints fix.** Breakpoints inside async tasks now fully work under both the native DAP and the WASM playground: a breakpoint in an `(async …)` / `(async/spawn …)` body stops, `Continue` resumes, inspection (stack/scopes/variables) targets the paused **task's** VM frames, and Step Over/Out follow the task's own call depth (gate tests: `crates/sema/tests/dap_async_breakpoint_test.rs`, `crates/sema/tests/wasm_async_debug_test.rs`, `playground/tests/debugger-async.spec.ts`). The one remaining gap: stepping (Step Into/Over/Out) does **not** follow control *across* the scheduler boundary into sibling tasks or back to the main VM — while a task is paused, siblings stay parked and a step stays within the current task slice. **Deferred because** cross-task stepping is a distinct design problem (the stepper would have to model the cooperative scheduler's task graph, not just one VM's frame depth), it's an enhancement rather than the reported bug, and the STOP+CONTINUE+inspect slice already covers the common debugging need. Revisit if async stepping across tasks becomes a real workflow ask.

---

Verified 2026-06-09: U6 ("did you mean" hints — shipped via `suggest_similar` in sema-core, attached in both backends) and U9 (REPL completeness check — replaced by the lexer-based `SemaValidator` in `crates/sema/src/repl/validator.rs`) were removed because they have since been fixed. Remaining entries re-verified as still open.

Verified 2026-07-01: **LEX-1** (scientific/exponential number literals — `1e19`, `2e-5`, `1E10` now parse), **VM-1** (VM stack traces on runtime errors — the VM now captures the call stack at error time and serializes it as `:stack-trace`), and **N7** (`sort` on heterogeneous types — comparator-free `sort` now raises a type error on mixed types and compares ints/floats numerically, `crates/sema-stdlib/src/list.rs`) were removed because they are fixed. Remaining entries re-verified as still open.

Fixed 2026-07-02: **ASYNC-3** (`async/all` early-reject stranding a span-owning
`IoHandle` to teardown) — `cancel_abandoned_combinator_siblings` in the scheduler
transitively cancels + IO-aborts a combinator's still-pending siblings when
`async/all` rejects or `async/race` settles, on the VM thread with the OTel
thread-locals alive. Commit `a2c8a0ad`; gates `async_all_reject_cancels_pending_sibling`,
`async_race_cancels_losing_siblings`, `combinator_short_circuit_spares_unrelated_task`
in `crates/sema/tests/vm_async_test.rs`. (This entry lingered here for a week after
the fix landed — the fix shipped the same day the entry was written.)

Fixed 2026-07-02: **ASYNC-1** (dynamic-scope flags vs deferred async tasks) — `llm/with-cache`/`llm/with-budget`/per-call `:tags` are now captured per task and swapped in/out at each scheduler step (a third per-task context beside the otel + usage-scope swaps), with the active budget frame shared by `Rc` so a concurrent `with-budget` fan-out charges one aggregate. See ADR #67, `docs/plans/2026-07-02-async-1-dynamic-scope-per-task.md`; gates `async_cache_miss_is_counted` + `async_budget_gates_concurrent_fanout` in `crates/sema/tests/complete_async_test.rs`. (The follow-up teardown gap it surfaced is now tracked as ASYNC-3 above.)

---

## LSP-CI-1 — LSP e2e suite not in CI; no positionEncoding/UTF-16 wire coverage

**Today:** the 17-file Python e2e suite under `crates/sema-lsp/tests/e2e/` runs
only locally (`jake test.lsp` → `uv run pytest`); no GitHub workflow invokes it,
so a protocol-level regression (initialize handshake, diagnostics push, code
lens) ships silently if nobody ran it. Separately, the server does no
`positionEncoding` negotiation and has no astral-plane UTF-16 wire tests.

**Proposed fix:** a CI job that installs `uv` and runs the pytest suite against
the debug binary; a `positionEncoding` capability + one surrogate-pair
regression test.

**Why deferred:** demoted from the archived
`plans/archive/2026-06-09-lsp-e2e-compliance-testing.md` (its larger in-process
harness design went stale when the editor plugins left the monorepo). These two
facts are the surviving actionable part.

**Workaround today:** run `jake test.lsp` locally before LSP releases.

---

## D5 — Typed `try`/`catch` form

**Today:** `(try expr (catch e ...))` catches *every* error type, including `:unbound`, `:arity`, `:type-error` — the kind of errors that usually mean a typo. The docs (`website/docs/language/special-forms.md` near "Re-throw errors you don't intend to handle") explicitly warn about this.

**The bug shape:** silent bug-masking. A typo inside `try` is swallowed and the catch block runs as if the operation failed for "real" reasons.

**Proposed fix (not done):** add `(catch [:user :type-error] e ...)` syntax that filters by the `:type` field, mirroring Clojure's `catch ExceptionType` or Common Lisp's `handler-case`. Optionally lint-warn on the un-filtered form.

**Why deferred:** non-trivial language design. Affects reader (new pattern in catch clause), special-form lowering in both backends, and prelude macros that use `try`. Needs an ADR before code.

**Workaround today:** users can do `(try ... (catch e (if (= (:type e) :user) (handle e) (throw e))))` to re-raise unexpected errors. That's a documented pattern in special-forms.md.

---

## VFS — clones on every read

**Today (updated 2026-06-09):** `vfs_read` returns `Option<Vec<u8>>`, cloning file contents on each call — the function now lives in `crates/sema-core/src/vfs.rs:15` (the embedded-binary VFS). The originally-cited `crates/sema-notebook/src/vfs.rs` has since become a different thing (disk-backed path-sandboxed shim) and is no longer relevant to this entry.

**Proposed fix:** return `Cow<'_, [u8]>` so cached reads can be borrowed, or back the VFS with `Arc<HashMap>` so the file table can hand out cheap reference-counted handles.

**Why deferred:** identified in PR #14 review (severity: medium). VFS read isn't a current hotspot — the notebook is interactive, not a high-throughput file server. Revisit if the notebook starts serving real bundles.

---

## WASM-4 — `register_wasm_io` is a single ~1093-line function

**Today:** `crates/sema-wasm/src/lib.rs` registers all WASM I/O builtins in one ~1093-line function. Large WASM functions carry a known V8 Turboshaft miscompilation/crash risk on ARM64 (see the chromium-wasm-crash note in MEMORY).

**Proposed fix:** split into smaller per-area registration functions (pure refactor, no behavior change).

**Why deferred (decided 2026-06-18):** latent risk only; the crash has not been observed since. Revisit if it recurs in the playground. Large diff on a hot path, not worth the churn now.

---

## TOOL-2 — Speed up CI drastically (it's painful)

**Deferred (revisit later) — 2026-06-22.** A release cycle takes painfully long: the
`verify` gate (full `cargo test --workspace` + examples + smoke-bytecode + lint +
docs-check) runs ~12–15 min on a **cold** cache, and it runs **per workflow** (CI on the
branch push, `publish.yml` verify on the tag, `publish-npm.yml` verify on the tag) — so a
release re-builds the world several times. Observed leads for a future push:

- **Caching is the big lever.** `Swatinem/rust-cache` keys per *job*, so each workflow's
  verify job has its own (often cold) cache; warm it / share it, or move to `sccache`
  with a shared backend. Cold-cache full builds are the dominant cost.
- **Split the gate for fast-fail.** Run `fmt` + `clippy` + `docs-check` as a quick job
  that fails in ~1 min; run the heavy `cargo test`/examples/smoke separately and in
  parallel (test sharding via `cargo-nextest --partition`).
- **Don't re-verify per registry.** crates.io and npm publishes each gate on `verify`
  today (kept separate because npm's OIDC whitelists the workflow *filename* — see
  `publish-npm.yml`). Find a way to share one verify result across both without breaking
  the OIDC filename match (e.g. a reusable verify that both `needs:`, gated so it runs
  once per SHA).
- **Faster runners.** GitHub's free runners are 2 vCPU. Managed drop-ins that work on a
  *personal* account (not just orgs): **Namespace** and **Ubicloud** (Blacksmith is
  org-only). ~2–3× wall-clock on a compile-heavy Rust suite.
- **cargo-dist Windows flakiness** (separate but related): the Windows build intermittently
  fails fetching from crates.io; mitigated by `.cargo/config.toml` (`[http] multiplexing
  = false`, `[net] retry = 10`) — keep an eye on whether that's enough.

---

## CASS-1 — Cassette tape corpus + replay-in-CI (cassettes M4)

**Deferred (revisit later) — 2026-06-22.** Cassette M1–M3 shipped in 1.23.0 (record/replay
for `complete`/`chat`/`extract`/agents/streaming/embeddings; `with-cassette` + `llm/cassette-*`
+ env vars). M4 — making the LLM/agentic suite run keyless in CI off committed tapes — is
unstarted. The implementation plan was archived to `docs/plans/archive/2026-06-21-llm-cassettes.md`.
Remaining work:

- **Record a tape corpus** for the playground `llm-tools` examples and the agentic test
  suite; wire `SEMA_LLM_CASSETTE_MODE=replay` into `jake test` so the suite runs green with
  no API keys. (The keyless oracle today is the scripted `FakeProvider`; cassettes would add
  real-response replay on top.)
- **Open questions** carried from the plan: a `NullProvider` inner so pure-replay needs zero
  credentials; tape versioning/migration when `ChatRequest`/`ChatResponse` shapes change (the
  `"v":1` field is the hook); tapes beside tests (`tests/tapes/`) vs. a top-level `cassettes/`
  (leaning beside-tests); one-tape-per-test vs. shared (leaning per-test).

---

## LLM-1 — LLM bulletproofing remnants (from the archived plan)

**Deferred (revisit later) — 2026-06-22.** The bulletproofing plan
(`docs/plans/archive/2026-06-21-llm-bulletproofing.md`) shipped Phases 0–3, 4.1, 4.2, 4.4,
5, and 6.3. What's left:

- ~~**4.3 — streaming through the dispatch layer**~~ ✅ **DONE 2026-06-23.** `llm/stream`
  now applies rate-limit + fallback at stream-open and an opt-in budget pre-gate
  (`:on-stream :pre-gate`); mid-stream failure surfaces + keeps the partial (no failover —
  the spike proved a retry would duplicate). Cache stays off for streams (cassettes cover
  deterministic replay). Verified live.
- **6.1 — `llm/generate-object`**: schema-validated structured output with a bounded repair
  loop (today only `llm/extract` does schema+reask). Reuse `validate_extraction` +
  `format_reask_prompt`.
- **6.2 — batch budget pre-flight**: budgets are post-call caps, so a concurrent
  `llm/batch`/`llm/pmap` fan-out can overshoot before the cap fires. Add a pre-dispatch
  token-estimate gate.
- **6.5 — agent eval harness**: a `deftest`/`eval` surface that scores an agent against a
  fixture task + cassette in CI. Explicitly deferred by owner; reuses FakeProvider/cassettes.

(Cassette CI corpus — plan's 6.4 — is tracked separately as CASS-1.)

---

## PG-1 — Playground → downloadable native binary

**Deferred (revisit later) — 2026-06-23.** Captured 2026-06-19 as a curiosity and
archived to `docs/plans/archive/2026-06-19-playground-binary-export.md`. The
playground runs the WASM build, but `sema build` isn't compilation — it's
concatenation (`[stock runtime] + [VFS archive] + [trailer]`), so the browser
could produce a byte-identical runnable native binary with **no compiler**: pick a
target, fetch the stock runtime (ideally mirrored same-origin on sema.run), append
the archive built from the editor contents, write the `SEMAEXEC` trailer, download.

**Feasibility high, effort low (~half a day)** — mostly UI + hosting the runtime
mirror. Preferred first step: factor archive-writing into a lib and expose a
`sema-wasm` binding returning `Uint8Array` (avoids format drift vs. reimplementing
the format in JS). Pointers: `crates/sema/src/archive.rs` (format),
`crates/sema/src/cross_compile.rs` (`SUPPORTED_TARGETS`, runtime download/cache),
`crates/sema/src/main.rs` `Commands::Build` + `pkg.rs`.

**Why deferred:** not scheduled — no demand pull, just an attractive proof-of-concept.
Resume from the plan's "Smallest proof-of-concept" section.

---

## A note on the truly long-term language design items

These are not deferred — they're design questions that need a deliberate decision before any code lands. They're tracked in `docs/wip.md` (the "Wave 6c" cluster), not here.

---

## WF-1 — Larger dynamic-workflow work

**Deferred larger dynamic-workflow ideas** that should not be folded into a quick-fix pass. Source discussion: the GitHub issue comment on dynamic workflows — https://github.com/sema-lisp/sema/issues/41#issuecomment-4815472955. (The core `defworkflow`/`phase`/`step`/`checkpoint`/`parallel`/`pipeline` runtime shipped in 1.28.0; the items below are the next-tier extensions.)

**Manager and subprocess agents**
- Add a `sema-workflowd`-style manager that owns run lifecycle, scheduling, budgets, retries, cancellation, subprocess supervision, and dashboard serving. Keep it deterministic — it supervises and journals work, it is not an LLM planning loop.
- Add subprocess agents with a JSONL protocol before sockets (inspectable, replayable, journal-first).
- Define `defsubagent` (or equivalent) metadata for command, protocol, timeout, sandbox, and compiled-executable agents.

**Run directory format**
- Snapshot the executed `workflow.sema` and `args.json` into each run directory.
- Add per-agent folders with `input.json`, `prompt.md`, `events.jsonl`, `stdout.log`, `stderr.log`, `result.json`, and a first-class `artifacts/` path for reports/patches/generated files.
- Treat the run directory as a stable public format that can be copied to another machine and replayed or inspected later.

**Resume and cache keys**
- Extend agent cache keys beyond the current workflow source/version, args fingerprint, phase, name, prompt, and schema representation to also include model, system prompt, tool set/version, agent source, and the relevant child sandbox.
- Decide whether checkpoint keys should include an explicit caller-provided input hash for values that depend on external state.
- Preserve backward-compatible behavior or provide migration notes when content-key fields change.

**Permissions**
- Keep `:permissions` as the workflow metadata key.
- Move beyond CLI sandbox strings toward a structured permission schema (e.g. read-only, test-agent, patch-agent, research-agent profiles); map workflow/agent permissions to child-process sandbox flags and `--allowed-paths`.
- Consider runtime-level enforcement for in-process workflow calls, not only CLI pre-run interpreter construction.

**Scheduler semantics**
- Make `parallel` a scheduler primitive with ordered results, independent completion order, bounded concurrency, and configurable fail-fast.
- Add task/agent handles with `await`, `await-all`, `cancel`, and `status`; make cancellation propagate downward to running child agents.
- Add `pipeline` as a streaming DAG/barrier-avoidance primitive once `parallel` semantics are settled.

**Dashboard operations**
- Project `events.jsonl` into the dashboard first; SQLite remains a secondary index.
- Add operator controls: pause/resume/cancel run, cancel/restart agent, inspect prompt/result/tool-transcript, export report.
- Prefer SSE over WebSockets for the first live local dashboard stream.

## AST-GREP-1 — Upstream `@ast-grep/lang-sema` PR to ast-grep/langs

**Found 2026-07-05.** ast-grep works with Sema today via its custom-language
mechanism (compile `tree-sitter-sema`'s grammar to a `.so`, point `sgconfig.yml`
at it) — verified end-to-end, no code changes needed on our side. A polished
`@ast-grep/lang-sema` package (the standard contribution path for
`@ast-grep/napi`'s `registerDynamicLanguage`) was written and passed its own
isolated test (nursery.js: parse, `(define $NAME $VAL)` match, metavariable
capture). Full details: `docs/plans/2026-07-05-ast-grep-support.md`.

**Attempted:** forked `ast-grep/langs`, dropped the package into `packages/sema`,
tried to verify it the way the monorepo expects — a root `pnpm install`
(needed because the root `postinstall` recompiles every workspace package).
That install fails for reasons unrelated to Sema: `tree-sitter-dart`'s native
Node binding doesn't compile against this machine's Node 26 (V8
`GetAlignedPointerFromInternalField` API changed), plus flaky npm-registry
timeouts fetching ~30 unrelated language grammars/binaries.

**Why deferred:** getting a green full-monorepo install wasn't worth fighting
through an unrelated package's broken native build. The lower-risk path (verify
`packages/sema` in an isolated standalone npm project outside the monorepo,
the way the original investigation did, then open the PR and let ast-grep's own
CI do the full build) was offered but the whole effort was parked for now
instead. **The `website/docs/ast-grep.md` docs page was pulled from the live
site and sidebar** (was briefly published) since the upstream package isn't
actually shipped — no point advertising `@ast-grep/lang-sema` before it exists
on npm. The CLI-only workflow (manual `.so` build) still works and needs no
package; it just isn't separately documented right now.

**To resume:** either (a) verify `packages/sema` standalone outside the
`ast-grep/langs` checkout and open the PR from that verified state, ignoring
the rest of the monorepo's install health, or (b) retry the full monorepo
install once `tree-sitter-dart` (or the Node/node-gyp toolchain) is fixed
upstream. A GitHub fork (`HelgeSverre/langs`) already exists with the package
staged in `packages/sema` if picking this back up.

## Notebook: per-cell + per-session LLM cost tracking (status bar)

Accumulate LLM spend for a notebook session and attribute it per cell / per
run, surfaced as a per-cell badge and a session-cumulative status bar. Scoped
2026-07-03 (see the GitHub issue for full context):

- **Cell boundary**: `NotebookEngine::eval_cell` (engine.rs:108) / `eval_cells`
  (:277); cells evaluate on the dedicated engine thread (bridge.rs), so
  sema-llm's thread-local accounting is stable across cells.
- **Mechanism**: reuse the per-leaf usage-scope seam (`open_usage_scope` /
  `LeafUsage`, sema-llm builtins.rs:127/187) — open a scope per cell eval. It is
  already async-correct: offload pollers fold into the Rc captured at dispatch
  (the ASYNC-1 guarantee), so spend from tasks/agents/streams started in a cell
  lands on that cell even though it settles in a poller.
- **Plumbing**: `EvalResult` (engine.rs:50) gains usage; `EvalResponse`
  (render.rs:164) serializes it; UI = ui/notebook.js + index.html (Alpine).
- **Semantics**: badge = last-run cost of the cell; status bar = session
  cumulative (parity with `(llm/session-usage)`); reset on kernel restart.
  Cache hits report zero (shows "re-runs are free"); cassette replays charge
  the recorded usage from the tape — decide whether to tag those visually.
- Headless `notebook run` should print the same summary line at the end.

Deferred: feature work, not async-runtime scope. Filed as a GitHub issue.

## SRV-TRAPS-1 — three live traps left behind by the `http/serve` concurrency work

**SRV-1 itself is resolved** (concurrent accept loop, task per connection,
cooperative server-side `ws/recv`, fail-fast guard deleted — see
[`deferred-resolved.md`](plans/archive/deferred-resolved.md) for the full design record). These
three hazards outlived it. None breaks anything shipped today; each is a silent
trap for the *next* caller who touches the same seam, which is why they are
recorded rather than left in the commit log.

1. **`spawn_via_registry`'s `ReturnOwner::VmResume` fast path silently drops a
   custom Spawn continuation** (`sema-vm/src/runtime/state.rs`). For
   `RuntimeRequest::Spawn` it injects the settled promise straight onto the
   parked VM's stack and `drop`s the caller-supplied continuation without ever
   calling it. That is byte-equivalent to `async/spawn`'s own trivial default
   continuation, but wrong for any other caller — and `owner` stays `VmResume`
   for every hop chained off a plain top-level call, so the fast path is the
   common case, not the exotic one. SRV-1's first attempt lost its "re-arm the
   next accept wait" continuation exactly this way; the symptom was a stray
   `<async-promise>` echoed by `-e` and an accept loop that never advanced past
   request one. **Workaround in use:** route the spawn through compiled bytecode
   (`__http-serve-dispatch-task` in `prelude.rs` calls `async/spawn` itself).
   **Real fix, unpicked:** either gate the fast path on the continuation being
   the trivial default (needs a type-identity check — fragile) or always route
   through the continuation (measure the `async/spawn` hot path first).

2. **`apply` routes only closures and known runtime-only natives through
   `NativeOutcome::Call`** (`sema-stdlib/src/list.rs`). Every other native —
   including a dual-ABI one whose two ABIs genuinely differ in capability, like
   `__http-serve-run` — takes `apply`'s synchronous fallback unconditionally, so
   applying it silently gets the weaker ABI. `http/serve`'s prelude wrapper
   avoids `apply` for this reason. The next native with divergent dual ABIs must
   do the same, or `apply`'s routing needs a capability marker.

3. **`in_runtime_quantum()` lies inside a `call_callback` body.**
   `sema-vm/src/vm.rs`'s `make_closure` "TEMPORARY BRIDGE" arm suspends the
   quantum for the call's duration by design (a Task-04-era necessity for
   ordinary synchronous callback re-entry — HOFs, tool handlers). So a
   suspending native invoked from inside another native's `call_callback` body
   silently falls back to its blocking path. SRV-1's piece (c) had to route
   *around* this via `NativeOutcome::Call` rather than through it.
   **Still unconverted:** `handle_sse_response`'s `call_callback` invocation of
   the SSE stream handler. A cooperative op inside an SSE handler body hits the
   identical silent fallback that `ws/recv` had before piece (c). Flagged, not
   fixed — no acceptance test currently exercises a suspending op inside an SSE
   handler body. Converting it means mirroring `handle_ws_response_runtime`'s
   dual-ABI `NativeOutcome::Call` shape for SSE.

## Consciously-not-converted blocking natives

**Found 2026-07-10, during the scheduler-blocking-natives sweep.** Two more
blocking-on-the-VM-thread spots were found and deliberately left as-is (not
tracked as bugs to fix later — the audit checked them and closed them):

- **`serial/*`** (`crates/sema-stdlib/src/serial.rs`) — `serial/read-line` and
  `serial/send` block up to the configured port timeout. Hardware-niche
  (`Caps::SERIAL`-gated, a real physical/virtual serial port must be attached)
  and low-traffic by nature — a script driving a serial device is not the
  concurrent-fan-out shape this wave targets. Revisit only if someone actually
  reports a serial script wanting to run concurrently with other async work.
- **Cold `import`/`load` and `sema/check-file`'s first-load read** (`import`:
  `crates/sema-eval/src/special_forms.rs`; `sema/check-file`:
  `crates/sema-stdlib/src/reflect.rs`) — the first time a module is imported,
  loaded, or checked, its source is read from disk and compiled synchronously.
  Narrow window (one file read, amortized by the module cache on every later
  reference) and not offload-able the way a leaf builtin is: compilation must
  run on the VM thread regardless (it calls back into the compiler/macro
  expander), so there is no simple "do the blocking part off-thread, resume
  with a `Value`" shape here — offloading only the file read would still leave
  the (usually larger) compile step blocking. Not worth the complexity for a
  one-shot, per-module cost.

## Unified runtime terminal-inventory — residual deferrals (2026-07-23, C7 sign-off)

Recorded when the terminal-inventory ledger was signed off
(`docs/plans/2026-07-19-unified-runtime-terminal-inventory.md`, Tasks 8–9 + C7).
Both are honest **narrowed-terminal** dispositions, not gaps to silently close.

- **R10B — PDF parser is not terminally bounded (subprocess isolation deferred).**
  `pdf/*` offloads `lopdf`/`pdf-extract` parsing over an owned byte snapshot under
  the quarantine `hard_deadline` cleanup net, and input-byte admission (R10A) is a
  terminal pre-dispatch reject. But the page/output caps run *post-parse*: `lopdf`
  can allocate/decompress object streams before the caps apply, so the parse step
  is bounded only by the wall-clock cleanup deadline, not a terminal `finite_work`
  unit cap. A truly terminal bound needs subprocess parser isolation (parse in a
  killable child under an RLIMIT), which is out of scope for the cooperative-runtime
  wave. Ledger row R10B is `MIGRATED (B9, split; documented NON-terminal parser
  bound)` — it does not claim BOUNDED.
- **R14B — serial bounded-checkout cancellation is unverifiable without hardware.**
  Serial ports expose no portable read-interrupt, so a cancelled `serial/read-line`
  cannot be aborted; R14B instead validates the port read timeout (`Some(_)`,
  non-zero, `<= SERIAL_MAX_OP_TIMEOUT`) before every dispatch, so a blocked worker
  frees within the validated bound. The `cancelled-op-settles-within-timeout`
  regression can only run against a loopback/pty-backed port; this environment has
  no serial hardware, so that arm is covered by the timeout-validation unit tests
  plus the no-hardware cancellation suite. Revisit if serial hardware coverage
  becomes available in CI.
- **B4 `io.rs` whole-file value-ABI read scanner guard — deferred (not a clean
  scan).** R08B's contract is already structural: `stream/open-*` and the `io.rs`
  quantum offloads admit only regular files (`io::admit_regular_file`), and the
  whole-file value-ABI reads (`file/read`, `file/read-bytes`) on the
  `!in_runtime_quantum()` host arm are HOST-ADAPTER-ONLY. A source guard to fail a
  raw whole-file read *reintroduced on the VM thread inside a quantum* cannot use
  the existing `RAW_STDIN_READ`-style active-runtime scanner: the legitimate
  in-quantum reads (`crates/sema-stdlib/src/io.rs` `std::fs::read_to_string`/`read`
  at the offloaded arms) sit **inside `quarantined_compute` worker closures** that
  the brace-matched `if in_runtime_quantum() { … }` block scan cannot distinguish
  from a direct VM-thread read, so the rule would false-positive and regress the
  green source-policy. A precise guard needs closure-aware analysis or a refactor
  that hoists the read out of the quantum block; deferred as a follow-up. (Unlike
  stdin, a file read inside a quantum is legal when offloaded, so the
  zero-tolerance stdin model does not transfer.)

## R10B — PDF parser terminal isolation (subprocess/parser isolation deferred)

**Recorded 2026-07-22 (Commit B9).** R10 splits into a terminal admission arm
and a non-terminal parser arm. **R10A** (input-byte admission) is genuinely
terminal: `pdf.rs`'s `open_pdf_runtime_input`/`check_pdf_limit` `stat`s the file
and rejects an oversized PDF on the VM thread BEFORE any worker runs — no worker
allocation. **R10B** (the offloaded parse) is NOT terminally bounded and is
deliberately left that way:

- The page and returned-text caps (`check_pdf_pages`/`check_pdf_text_output`) run
  **post-parse**. `lopdf::Document::load_mem` and `pdf_extract::extract_text_*`
  can allocate and decompress object/content streams while loading — before the
  page count or output size is known — so a hostile PDF can drive unbounded
  intermediate allocation on the worker even though the *input* bytes are capped.
- Consequently R10B keeps the `hard_deadline` cleanup net (via
  `quarantined_compute`), **not** a `QuarantineBound::finite_work` descriptor. Its
  ledger row states a documented NON-terminal parser bound rather than claiming
  BOUNDED — the honest disposition (contrast R02 archive, whose caps are enforced
  incrementally on the worker and so declares `finite_work`).
- **Terminally bounding the PDF parser needs isolation the in-process design
  can't provide.** `lopdf`/`pdf-extract` expose no incremental-allocation or
  interrupt hook, so the only way to cap their peak allocation/CPU terminally is
  to run the parse in a **subprocess** (rlimit/cgroup-bounded, killable) or behind
  a parser that streams with a hard allocation budget. That is a separate design
  (process pool, IPC of the byte snapshot and the extracted text/metadata,
  cross-platform kill+reap) and is deferred. Until then the `pdf/*` ops remain
  available and offloaded under the hard cleanup deadline.
