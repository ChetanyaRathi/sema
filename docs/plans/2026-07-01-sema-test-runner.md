# Design — `sema test` native test runner

**Status:** Design (approved for planning) — 2026-07-01. Implementation not started.

A native, batteries-included test runner for Sema: a `deftest` DSL with rich
matchers, a `sema test` subcommand with pretty + machine-readable reporters, an
MCP tool so agents can run tests autonomously, and first-class support for
deterministic LLM testing via the existing cassette layer.

## Motivation & goals

Sema has `assert`/`assert=` (in `crates/sema-stdlib/src/meta.rs`) that throw a
catchable `SemaError`, and examples ad-hoc a custom `assert-eq` helper. There is
no test *runner*: no discovery, no grouping, no result aggregation, no
machine-readable output, no way for an agent to run a suite and read the result.

This feature serves three audiences equally:

1. **End users** writing tests for their Sema apps/agents — a polished,
   vitest-quality authoring + reporting experience.
2. **Coding agents** — an MCP `run_tests` tool returning structured results, so an
   agent can write Sema, run tests, read failures, and iterate autonomously.
3. **Dogfooding** — testing Sema's own stdlib/examples in-language.

### Non-goals (initially)

- Not replacing the Rust integration test suite (`crates/sema/tests/`); this is a
  *Sema-language* test runner, complementary.
- No property-based/generative testing, no coverage instrumentation, no parallel
  test execution in Phase 1 (revisit later).
- No `defroute`-style special forms — the DSL is macros + native recorders only.

## Design overview

Four moving parts:

- **DSL** (`deftest` / `testing` / matchers) — prelude macros + native recorder
  functions that register tests and record assertion outcomes at eval time.
- **Runner** — discovers test files, evaluates each in a fresh interpreter (which
  registers its tests), runs the registered test thunks, and aggregates a result
  model.
- **Reporters** — render the result model as pretty/dot/json/junit/html.
- **Surfaces** — `sema test` CLI subcommand and an MCP `run_tests` tool, both
  driving the same runner.

## 1. Authoring DSL

### Registration model: load-and-register

Evaluating a test file *is* discovery. `deftest` registers a named thunk into a
runtime **test registry** (a thread-local `Vec` in the eval context / a native
module), tagged with its source location and the enclosing `testing` group path.
This is the clojure.test / RSpec model and gives parameterized and dynamically
generated tests for free (a `deftest` inside a loop just registers more).

```sema
(deftest "addition works"
  (is (> 5 3))
  (is= 4 (+ 2 2))
  (is-throws (/ 1 0))
  (is~ 3.14 (approx-pi) 0.01)
  (is-match #"ali" "alice")
  (testing "collections"
    (is-contains 2 [1 2 3])
    (is-empty? '())))
```

- `deftest` takes a string name and a body. Nesting via `testing` (a string label
  + body) builds a breadcrumb path (`file > group > test`) used in reporters.
- Nested `testing` groups are supported from Phase 1.

### Report-and-continue semantics (key decision)

Unlike `assert`/`assert=` (which raise and stop at the first failure), test
matchers **record a pass/fail into the currently-running test and continue**
(the rackunit model). A single test surfaces *all* its failed assertions in one
run. An *uncaught* error (not an assertion — e.g. an unbound var or a thrown
`SemaError` outside a matcher) marks the test as **errored** (distinct from
failed) and aborts that test only; the runner moves to the next.

### Form capture for good failure messages

`is` is a macro that captures the *unevaluated* form so failures print the
expression and its operands without a matcher library (pytest assertion-rewriting
/ Clojure `is` trick):

```
(is (> 5 10))   ; expands to:
(__test/record-is '(> 5 10) (fn () (> 5 10)))
```

`is=` captures both sides for a diff:

```
(is= expected actual)  ; expands to:
(__test/record-eq '(is= expected actual) (fn () expected) (fn () actual))
```

The `__test/*` recorders are native functions in a new `sema-stdlib` `test.rs`
module; the `deftest`/`testing`/`is*` macros live in `crates/sema-eval/src/prelude.rs`.

### First-ship matcher set

Grouped (canonical names in parens):

- **Equality/identity**: `is=` (deep equal), `is-not=` — leans on Sema structural `=`.
- **Generic boolean**: `is` (truthy, with form capture), `is-not`.
- **Nil/predicate**: `is-nil?`, `satisfies?` (takes any `?`-predicate: `(satisfies? empty? x)`), which subsumes the predicate family (`null?`, `list?`, `file/exists?`…).
- **Comparison**: covered by `is` over `<`/`>`/`<=`/`>=` with form capture (no dedicated matchers needed).
- **Float tolerance**: `is~` (`(is~ expected actual epsilon)`).
- **Exceptions**: `is-throws` — no-arg (throws at all), or with an expected error-message substring/regex.
- **Collections**: `is-contains`, `is-empty?`, `has-length?`.
- **Strings/regex**: `is-match` (regex literal or substring).
- **Negation**: a single `is-not` modifier rather than paired `*-not` twins.

## 2. Result model

A serializable tree the runner produces and every reporter consumes:

```
Run { files: [FileResult], started, duration, totals: {files, tests, passed, failed, errored, skipped} }
FileResult { path, tests: [TestResult], load_error? }
TestResult { name, group_path: [String], status: Passed|Failed|Errored|Skipped,
             duration_ms, assertions: [AssertionResult] }
AssertionResult { kind, form: String, expected?, actual?, message?, location: {file,line,col}, passed }
```

Exit code: `1` if `failed + errored > 0` (or any file failed to load), else `0`.

## 3. Discovery & isolation

- **Default** (bare `sema test`): glob `**/*.test.sema` from the working dir, plus
  any files under a `test/` or `tests/` directory. The `.test.sema` naming is a
  convention for humans/IDEs; Sema itself doesn't care about the extension.
- `sema test <path>` runs an explicit file, directory, or glob (any `.sema`).
- `--all` widens discovery to every `.sema` (documented as risky: it evaluates
  arbitrary scripts, which may have top-level side effects).
- A cheap **filename glob gates which files get loaded** so we don't eval the whole
  project; within each loaded file, `deftest` registration does the rest.
- **Isolation**: each test file is evaluated in a *fresh* `Interpreter` (its own
  global env + registry). Prevents cross-file state bleed and contains side
  effects. (Trade-off: slower than a shared env; acceptable, and revisitable if it
  becomes a bottleneck.)

## 4. CLI surface

```
sema test [PATHS...] [--reporter <name>] [--json] [-o <file>]
          [--filter <substr>] [--all] [--update-cassettes] [--no-color]
```

- `PATHS` — files/dirs/globs; empty = default discovery.
- `--reporter pretty|dot|json|junit|html` — default `pretty` on a TTY, `dot` or
  minimal when non-TTY (agent/CI).
- `--json` — shorthand for `--reporter json`.
- `-o <file>` — write the reporter output to a file (keeps stdout clean for the
  pretty reporter; required-ish for junit/html in CI).
- `--filter <substr>` — run only tests whose name/group-path contains the substring.
- `--update-cassettes` — see §6.

Dispatch mirrors existing subcommands: add `Commands::Test { .. }` to the clap
enum in `crates/sema/src/main.rs` and a `run_test(..)` handler.

## 5. Reporters

Consume the result model. Phase noted per reporter.

- **pretty** (Phase 1, default TTY) — Vitest-style: `✓`/`×` glyph tree with
  group indentation, passing files collapsed to a one-line count+ms, a
  `-Expected` / `+Received` diff (with legend, not color-only) for `is=`
  failures, a bottom **Failed Tests** block per failure = breadcrumb
  (`file > group > test`) + message + diff + code frame with a `^` caret and a
  clickable `file:line:col`, and a two-tier `Test Files … / Tests …` summary line.
  Scalars skip the diff and print a two-line Expected/Received.
- **dot** (Phase 2) — one char per test (`.`/`F`/`E`/`s`), summary at end.
- **json** (Phase 1) — Jest/Vitest-shaped (`success`, `numTotalTests`,
  `numPassedTests`, `numFailedTests`, `testResults[].assertionResults[]` with
  `title`, `ancestorTitles`, `fullName`, `status`, `duration`, `failureMessages`,
  `location`). This is what the MCP tool returns.
- **junit** (Phase 2) — JUnit XML (`testsuites/testsuite/testcase` with
  `failure`/`error`/`skipped`). CI interchange for GitHub Actions
  (`dorny/test-reporter`), GitLab (`artifacts:reports:junit`), Jenkins.
- **html** (Phase 3) — self-contained HTML report.

Reporters live in `crates/sema/src/test_runner/report/{pretty,dot,json,junit,html}.rs`
behind a small `Reporter` trait (final-model in; event hooks can be added later
for live/watch).

## 6. LLM / cassette testing

Deterministic LLM tests reuse the existing Sema-level cassette API
(`crates/sema-llm/src/cassette.rs`, builtin `(llm/with-cassette path opts thunk)`
with `:mode :record|:replay|:auto`):

```sema
(deftest "agent extracts a person"
  (llm/with-cassette "cassettes/extract.jsonl" {:mode :replay}
    (fn ()
      (is= "Alice" (:name (extract-person "Alice is 30"))))))
```

- **CI default is replay** → keyless, deterministic, offline.
- `sema test --update-cassettes` sets a runtime override (a dynamic flag the
  runner installs) so `with-cassette` calls record/refresh (`:record`/`:auto`)
  instead of replaying — the one small hook needed in the cassette layer to honor
  a global override. Running this once with real API keys captures the tapes that
  CI then replays.

## 7. MCP `run_tests` tool

Add to `crates/sema-mcp/src/tools.rs` (registry tuple + `call_mcp_tool` arm):

- **Args**: `{ paths?: [string], pattern?: string, filter?: string }`.
- **Returns**: the **json reporter model** (structured pass/fail + failure
  messages + locations), so an agent can programmatically see what broke and fix
  it. `isError` set when the run has failures/errors.
- Reuses the identical runner + json reporter — no divergent logic.

## 8. Flagship test suites (living examples + dogfood)

Two suites shipped as examples and wired into CI:

1. **Pure-logic suite** — a non-trivial parser or data-transform (e.g. a small
   CSV/JSON-ish parser or an interpreter kata) tested with the core matchers. No
   LLM. Proves ordinary unit testing and exercises the diff/failure UX.
2. **Tool-using LLM agent suite** — a small `deftool`-driven agent loop (e.g. a
   lookup/research agent). Real provider responses recorded once to a cassette
   (`--update-cassettes`), replayed deterministically in CI. Proves cassette-based
   LLM testing, tool-call correlation, and the agent path end-to-end.

## 9. Testing the runner itself

- **Rust integration tests** (`crates/sema/tests/`) invoke the runner over fixture
  `.test.sema` files (passing, failing, erroring, nested, skipped) and assert on
  the exit code and the **json** output shape — deterministic and CI-friendly.
- **Reporter snapshot tests** for junit XML and json against a fixed result model.
- **LLM flagship** runs under cassette replay in CI (no keys), and optionally
  under `FakeProvider` for the agent-loop mechanics.

## 10. Code layout summary

| Piece | Location |
|-------|----------|
| `deftest`/`testing`/`is*` macros | `crates/sema-eval/src/prelude.rs` |
| Native recorders + registry (`__test/*`, `test/*`) | new `crates/sema-stdlib/src/test.rs` |
| Runner (discovery, per-file eval, aggregation, result model) | new `crates/sema/src/test_runner/mod.rs` |
| Reporters | `crates/sema/src/test_runner/report/{pretty,dot,json,junit,html}.rs` |
| CLI `Commands::Test` + `run_test` | `crates/sema/src/main.rs` |
| MCP `run_tests` | `crates/sema-mcp/src/tools.rs` |
| Cassette `--update-cassettes` override hook | `crates/sema-llm/src/cassette.rs` |
| Flagship suites | `examples/tests/` (pure + agent) + cassette tapes |
| Docs | `website/docs/` test-runner page + `crates/sema-docs/entries/` for new builtins |

## 11. Phasing

- **Phase 1 — MVP**: `deftest`/`testing` + core matchers with report-and-continue
  and form capture; the registry; default discovery + per-file isolation; the
  runner + result model; **pretty** and **json** reporters; `Commands::Test` with
  exit codes; the **pure-logic flagship suite**; runner integration tests.
- **Phase 2 — machine output + agents**: **junit** and **dot** reporters;
  `--filter`; timing/phase breakdown polish; the **MCP `run_tests` tool**.
- **Phase 3 — LLM testing + HTML**: `--update-cassettes` hook; the **tool-using
  agent flagship suite** under cassette replay; **html** reporter; docs page.
- **Phase 4 — later**: `--watch` mode (single-key rerun filters); consider
  parallel execution, coverage, TAP reporter, property-based testing — all
  deferred until demand.

## 12. Open questions / risks

- **`is` form capture without a special form**: needs macro hygiene to avoid
  capturing user bindings in the generated thunks/quotes. Prelude macros expand
  VM-natively; verify gensym usage in the expansion.
- **Registry location**: thread-local in `sema-stdlib` vs a field on `EvalContext`.
  Fresh-interpreter-per-file makes a thread-local acceptable, but confirm it plays
  with the fresh-interpreter isolation (clear on interpreter creation).
- **Cassette global override**: adding a process/dynamic override to
  `with-cassette` must not regress the existing per-call `:mode` behavior or the
  keyless CI tests in `llm_cassette_test.rs`.
- **Non-TTY reporter default** for agents: ensure the MCP path never emits ANSI.

## Prior art (grounding)

- clojure.test (`deftest`/`is`/`testing`, var `:test` metadata), Kaocha (testable
  tree as data), rackunit + `raco test` (report-and-continue, `test` submodule),
  FiveAM/Rove (suite registries), SRFI-64.
- Vitest/Jest reporter UX (two-tier summary, code-frame failure block, `-Expected/
  +Received` diff, dot/json reporters).
- JUnit XML (CI lingua franca), TAP (deferred), Jest `--json` shape.
