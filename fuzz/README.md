# Grammar fuzzer (in Sema)

A grammar-based fuzzer for Sema, **written in Sema itself** (`grammar-fuzz.sema`).
It generates random *valid* Sema programs and checks them against correctness
oracles. It complements the byte-level `cargo-fuzz` targets in
`crates/sema-reader/fuzz` and `crates/sema-eval/fuzz`, which mutate raw bytes to
find parser/evaluator panics. This one generates *structured, valid* input, so it
reaches past the parser into the compiler and VM.

## Why generate (instead of mutate)?

Because Sema is homoiconic, a generated program *is* an ordinary Sema value, which
makes two sharp oracles nearly free:

1. **Round-trip — printer vs. reader.**
   `(= form (read (str form)))`. We generate arbitrary valid s-expression *data*
   (nested lists, vectors, maps, and every atom kind: ints, floats, bools, nil,
   strings, symbols, keywords, chars) and assert that printing then re-reading
   yields a structurally equal value. Any asymmetry between Sema's printer and
   reader falls straight out.

2. **Value oracle — compiler/VM vs. straight-line evaluation.**
   `(= expected (eval form))`. We generate *well-typed, closed* integer/boolean
   programs and compute their expected value **bottom-up while generating them**
   (applying the same primitive ops incrementally). Then we `eval` the whole
   nested form, which drives the full `macro-expand → lower → optimize → compile →
   bytecode-VM` pipeline, and compare. A mismatch means the compiled/optimized
   form disagrees with incremental evaluation — i.e. a bug in constant folding,
   `if`/`let` lowering, closure capture, TCO, or short-circuit logic.

3. **Metamorphic / differential laws — independent oracle for native ops.**
   The value oracle computes `expected` by calling the same builtin the form
   uses, so a bug in a single-implementation native op (`reverse`, `sort`, `map`,
   …) masks itself: both sides route through the broken op and agree. To cover
   those, the fuzzer also generates *theorems* whose expected value is the literal
   `#t` — e.g. `(= (reverse L) (foldl (fn (a x) (cons x a)) (list) L))`,
   `(= (append (take n L) (drop n L)) L)`, distributivity
   `(= (* a (+ b c)) (+ (* a b) (* a c)))`. Expected is `#t` by construction (not
   by running the op), so a broken op makes the sides disagree → caught. This
   found the inline add/sub integer-corruption bug.

4. **Hard crashes — VM panics.** Release builds are `panic = "abort"`, so a VM
   panic kills the process. The driver records each iteration's seed to a
   breadcrumb file *before* running it, so a crash is still reproducible from one
   integer seed.

The typed programs are **well-typed, closed** programs over `int`, `bool`,
`float`, `string`, `list`, `vector`, and `map`, covering arithmetic (incl.
variadic, `min`/`max`/`mod`/`abs`/`expt`), bitwise ops, comparisons, numeric &
type predicates, `and`/`or`/`not`, `if`/`cond`/`case`, `match` (incl. binding),
multi-binding `let`, multi-arg & curried lambdas, `try`/`throw`/`catch`, `apply`,
named-let TCO recursion at large N, the list/vector/map/string stdlib ops, and
deterministic concurrency (`async/all` + order-independent channel fan-in). Every
form evaluates to a known value, so the oracle stays exact. **`set!` is
deliberately excluded** — the value oracle's bottom-up model only holds for
referentially-transparent expressions.

## Async mode (`SEMA_FUZZ_ASYNC=1`)

With the gate on, the generator also produces async programs biased toward the
runtime's historical bug shapes: small-capacity (1–3) channel pipelines that
park senders and receivers, multi-sender fan-in, `channel/close` waking parked
tasks, `channel/try-recv` in deterministic positions, spawn trees with detached
value-neutral children, cancellation of tasks parked in every wait kind (virtual
timer, channel recv, channel send, offloaded blocking `sleep`), the owned
combinators (`async/map`, `async/pool-map`, `async/spawn-all`,
`async/race-owned`, `async/with-timeout`) on both success and fail-fast paths,
`async/race` with a deterministic winner, causal park-vs-pin ordering, and
offloaded file I/O leaves.

Two construction rules keep the value oracle exact:

- **Confluence by construction.** A program's value is independent of
  interleaving: order-independent reductions (sum), deterministic winners
  (exactly one non-parked race candidate), value-neutral effects (sleeps,
  cancelled losers), and post-settle reads only (`async/cancelled?` is read
  after awaiting the cancelled promise, never right after `async/cancel`).
  No production asserts a wall-clock upper bound.
- **Termination by construction.** Sends and recvs are balanced, or the
  imbalance is resolved by a close or cancel the generator also emits; sleeps
  are ≤ 5 ms; capacities are 1–3 — small enough to park senders, never enough
  to deadlock a balanced program.

### Confluent-value twin oracle

The generation-time expected value is a model, and a bug in the model could
agree with a buggy runtime. In async mode, every generated program whose async
constructs are all mechanically de-asyncable is therefore also checked against
an independent **sequential twin**, derived by a structural rewrite:

| construct                      | twin                    |
| ------------------------------ | ----------------------- |
| `(async B …)`                  | `(begin B …)`           |
| `(async/await X)`              | `X`                     |
| `(async/all (list E …))`       | `(list E …)`            |
| `(async/map F XS)`             | `(map F XS)`            |
| `(async/pool-map F XS W)`      | `(map F XS)`            |
| `(async/spawn-all (list T …))` | `(list (T) …)`          |
| `(async/sleep K)`, `(sleep K)` | `nil` (effect position) |

The async program, its sequential twin, and the model must all produce the
same value, so a bug in the generation-time model cannot self-mask. Programs
containing a construct with no mechanical twin — any `channel/*` op,
cancellation, race, timeout, the offload file ops, or a `throw` inside an
owned combinator (fail-fast cancels siblings; plain `map` does not) — skip the
twin and are covered by the generation-time model plus the `#t` laws embedded
in their forms (`cancelled?`, `closed?`, caught error markers, race-winner
identity). The oracle class of every async production is recorded in a comment
table in `grammar-fuzz.sema` above the productions; a new production must add
a row there. Unknown `async/*` and `channel/*` ops block twinning by default,
so a future production cannot be silently mistwinned.

Each async check batch ends with a stat line that proves the twin oracle ran
instead of passing vacuously:

```
twin-oracle: checked=11 non-mechanical=28 rewrites: async=24 await=10 all=5 map=2 pool-map=3 spawn-all=0
```

`checked` counts programs whose twin was derived and evaluated (a program with
no async construct twins to itself and is not counted); `non-mechanical`
counts programs skipped because of a blocked construct; the rewrite counts
show which construct rewrites fired. The twin walker consumes no RNG and no
gensym, so the seed-to-program mapping is identical with and without the
oracle.

Because generated programs may park, async check mode runs seeds in batches
per subprocess with an **external watchdog** (`-b` batch size, default 100;
`-t` per-program budget in seconds, default 5). A batch that exceeds
`batch × budget` is killed and the breadcrumb seed is reported as a **HANG**
finding. The watchdog is external on purpose: an in-program `async/timeout`
rides the same timer wheel whose wedging is one of the bug shapes under test.

### Shutdown-leak harness (Rust)

The runtime introspection the shutdown oracle needs (`runtime_live_task_count`,
`runtime_resource_gate_count`, `Interpreter::shutdown` → `ShutdownReport`) is
not a Sema builtin, so that oracle lives in a Rust integration test:
`crates/sema/tests/fuzz_async_shutdown_test.rs` (`#[ignore]` by default — run
it via `jake fuzz.async-shutdown`). It generates programs with emit mode (same
seed-to-program mapping as check mode), evals each in-process, and asserts:

- zero live tasks after settlement plus a bounded drain of leftover detached
  work (a task still live after the drain is a leak, not by-design
  persistence — generated detached children are value-neutral sleeps);
- the resource-gate count back to its pre-eval baseline;
- `shutdown` reports `clean` with no invariant failures.

It runs each seed range twice, in two drive modes:

- **Fresh interpreter per seed, default `drive()`** — the native CLI shape.
- **Paired roots under `drive_roots`** — seed pairs (A, B) on one shared
  interpreter, each root driven only through the selection-scoped
  `drive_roots`, natively reproducing the wasm driving shape and the v1.31.1
  orphaned-pending-stage recipe: A's leftover detached state stays parked
  across a deliberate undriven wall-clock gap, then B is submitted with an
  `async/sleep` appended as its final form (a timer probe). A timer wheel
  wedged by A's leftovers hangs B, and the harness's per-root deadline turns
  the hang into a failure naming both seeds.

The harness reads `SEMA_FUZZ_SEED`/`SEMA_FUZZ_COUNT`/`SEMA_FUZZ_DEPTH` from
the environment (defaults 0/100/4); every failure message carries the seed,
the generated program, and the emit repro line.

### Nightly CI

`.github/workflows/nightly.yml` (`grammar-fuzz` job) runs the deterministic
20000-seed sync sweep, a 5000-seed async batch at depth 5 and another at
depth 6 (both with the watchdog and all oracles), and the shutdown harness at
500 seeds. The seed base rotates with the workflow run id and is printed by
every step and echoed into the job summary with the per-batch twin-oracle
stat lines, so a red night reproduces from the logged base.

## Running

```bash
jake fuzz.grammar                          # default sweep, random seed
jake fuzz.grammar seed=123 n=20000 depth=5
jake fuzz.grammar-emit n=10                 # print sample generated programs
jake fuzz.async n=5000                      # async mode (watchdog, exit 3 on hang)
jake fuzz.async-emit n=10                   # print sample async programs
jake fuzz.async-shutdown n=500 depth=5      # Rust shutdown-leak harness

# jake exposes n/depth/seed; verbose, emit-to-file, and the watchdog knobs are
# driver-only (no rebuild):
./scripts/grammar-fuzz.sh check -n 5000 -d 4 -v       # verbose: print passing forms too
./scripts/grammar-fuzz.sh check --async -n 5000 -b 100 -t 5
./scripts/grammar-fuzz.sh emit  -n 50 -s 7 -o /tmp/progs.sema
```

The driver exits `0` on success, `1` on a deterministic mismatch (round-trip or
value oracle), `2` on a hard crash, and `3` on a hang (async watchdog). In every
failure case it prints the exact reproduction command. An eval error the
oracle's `try` cannot catch (a runtime invariant fault) aborts the fuzzer
mid-iteration; the driver detects that via the breadcrumb, reports it as
`ABORT`, and exits `2`. Such faults can depend on runtime state left by earlier
iterations in the same process, so their reproduction line replays the batch
from its base seed instead of `COUNT=1`.

### Reproducing and minimizing a finding

Iteration *i* uses seed `base + i` and re-seeds the PRNG, so each finding
reproduces from a single seed with count 1:

```bash
# see the offending program:
SEMA_FUZZ_MODE=emit SEMA_FUZZ_SEED=<seed> SEMA_FUZZ_COUNT=1 \
  ./target/release/sema fuzz/grammar-fuzz.sema

# re-run just that case under the checker:
SEMA_FUZZ_SEED=<seed> SEMA_FUZZ_COUNT=1 \
  ./target/release/sema fuzz/grammar-fuzz.sema
```

Add `SEMA_FUZZ_ASYNC=1` to both commands when the finding came from async mode
— the gate changes the seed-to-program mapping.

Lower `SEMA_FUZZ_DEPTH` to shrink the form, then hand-minimize from the emitted
program.

## Configuration (environment variables)

| Variable               | Meaning                                              | Default  |
| ---------------------- | --------------------------------------------------- | -------- |
| `SEMA_FUZZ_SEED`       | base seed                                            | `0`      |
| `SEMA_FUZZ_COUNT`      | iterations / programs                                | `200`    |
| `SEMA_FUZZ_DEPTH`      | max generation depth                                 | `4`      |
| `SEMA_FUZZ_MODE`       | `check` (run oracles) or `emit` (print programs)     | `check`  |
| `SEMA_FUZZ_OUT`        | emit mode: output file (else stdout)                | stdout   |
| `SEMA_FUZZ_CRASH_FILE` | check mode: breadcrumb file for the in-flight seed   | (unset)  |
| `SEMA_FUZZ_VERBOSE`    | `1` to also print passing forms                     | `0`      |
| `SEMA_FUZZ_ASYNC`      | `1` to enable the async productions                  | `0`      |

## Extending the grammar

The generator is small and self-contained. To add a production:

- **New typed (evaluable) form** — add a case to the relevant generator (`gen-int`,
  `gen-bool`, `gen-flt`, `gen-str`, `gen-ilist`, `gen-vec`, `gen-map-v`) and a
  helper that returns `(mk form value)`. Keep it **total** (no errors for any
  input) so the oracle stays exact, and **pure** (no `set!` / side effects).
  Bump the `(rng-int! N)` arms count to include it.
- **New law** (`gen-law`) — for a native op whose only implementation is the one
  under test, do *not* compute `expected` by calling it (that self-masks bugs).
  Add a metamorphic theorem cross-checking it against an independent computation;
  the expected is `#t`.
- **New datum kind** (round-trip coverage) — add a case to `gen-atom` or a new
  container to `gen-datum`. Make sure it round-trips (e.g. unique map keys so the
  literal doesn't collapse; avoid string contents the printer can't yet escape —
  see the note on `*str-alpha*`).

## Known limitations / deliberate exclusions

- **String alphabet.** Generated strings draw from `*str-alpha*`, which
  includes `"`, `\`, newline, and tab (the printer escapes them inside
  containers, and that round-trips) but not the full character space. One
  printer asymmetry remains: `str` renders a *top-level* string in display
  form (unquoted), so emit mode renders bare-string programs with
  `(format "~s" f)` to keep the output readable (`program->source`).
- **No reference interpreter.** The value oracle compares the VM against
  *incremental* evaluation using the same primitives, so on its own it targets the
  compiler/optimizer/VM rather than the primitives themselves (it self-masks bugs
  in single-implementation native ops). The **metamorphic laws** (`gen-law`) close
  that gap for the ops they cover by cross-checking against independent
  computations; a full external reference (e.g. another Scheme) would extend it
  to every primitive's semantics.
- **Floats** are generated as `k/1000`; they test float printing + shortest
  round-trip parsing, not the full float space.
