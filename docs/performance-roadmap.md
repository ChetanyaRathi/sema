# Performance Roadmap

Where Sema's time goes and what can be done about it. Based on analysis of the 1BRC benchmark (the most measured workload) and compute-heavy benchmarks (TAK, deriv).

## Current State

The bytecode VM is the sole evaluator. (The tree-walker was eventually retired — historical numbers for it are no longer relevant.)

As of the July 2026 performance campaign, **Sema is ahead of Janet on every benchmark in the suite** (PGO builds, Apple M2 Max, hyperfine, interleaved head-to-head runs):

| Benchmark | Janet | Sema (PGO) | Margin |
| --- | ---: | ---: | --- |
| tak (500× tak 18 12 6) | 1,190ms | 937ms | 1.27× ahead |
| nqueens (500× n=8) | 1,704ms | 1,497ms | 1.14× ahead |
| 1BRC optimized, 10M rows | 5,058ms | 3,619ms | 1.40× ahead |
| 1BRC simple, 10M rows | 10,116ms | 6,359ms | 1.59× ahead |

What delivered it (rough order of impact): the byte-oriented 1BRC rewrite on the `mutable-array/*` + `bytes/*` + `file/fold-lines-bytes` APIs; `TakeLocal` + the owned-args callback protocol (a fold accumulator reaches `assoc`'s COW gate with refcount 1, so idiomatic immutable-update folds mutate in place); `CallSelf` for top-level self-recursion; SmallVec native-call arg buffers; `run_inner` monomorphized over debug mode; self-tail-call on internal defines; the `string->number` fast decimal parse; `MutArrGet`/`MutArrSet` intrinsics. PGO adds a further ~10–25% on top.

Janet remains the most meaningful comparison — both are embeddable scripting languages with bytecode VMs, no JIT, no native compilation. For the cross-Lisp comparison, see `website/docs/internals/lisp-comparison.md` (numbers there predate this campaign until the multi-dialect runner is re-run).

## Where the Time Goes

### ~60% — Stdlib call overhead

Every `string/split`, `assoc`, `string->number` goes through: VM → `CallGlobal` → hash lookup in `Env` → downcast `Rc<NativeFn>` → allocate args slice → call Rust function → wrap result back to `Value`. Janet's register VM calls C functions with a direct pointer — no `Rc` downcasting, no `ValueView` unpacking.

### ~25% — Rc refcounting

Every `Value::clone()` is an `Rc::clone()` for heap types (strings, lists, maps). Every drop decrements. The NaN-boxing is clever — small ints/bools/symbols are unboxed `u64` — but strings and lists still pay the refcount cost on every copy and drop. Janet uses a tracing GC, so copies are free (just pointer copies) and collection is batched.

### ~15% — Data structure overhead

`BTreeMap` for env lookups, `Rc<Vec<Value>>` for lists (no cons cells), `Rc<String>` for every string value. Each imposes allocation and indirection costs on hot paths.

## Tier 1: Big Wins (2–5× total speedup possible)

### 1. Inline common stdlib into VM opcodes ✅ (partial)

**Impact:** Measured 1.28× on deriv, 1.10× on closure-storm
**Effort:** Medium (days)
**Status:** ✅ Arithmetic/comparison, list/predicate, and map/collection ops (Feb 2026) + string ops (`StringLength`/`StringRef`/`StringAppend`, Jun 2026, shipped v1.19.2). Only `apply`/`display` remain (control-flow/IO — deferred).

The biggest single win. Instead of `CallGlobal("car")` → hash lookup → NativeFn → call, emit dedicated opcodes like `OpCar` that operate directly on the stack in the dispatch loop.

**Done** (arithmetic + comparison, earlier): `+`, `-`, `*`, `/`, `<`, `>`, `<=`, `>=`, `=`, `not` (`AddInt`, `SubInt`, etc.)

**Done** (list + predicates, Feb 2026): `car`/`first`, `cdr`/`rest`, `cons`, `null?`, `pair?`, `list?`, `number?`, `string?`, `symbol?`, `length` — 10 new opcodes (`Car`, `Cdr`, `Cons`, `IsNull`, `IsPair`, `IsList`, `IsNumber`, `IsString`, `IsSymbol`, `Length`). Measured impact: deriv 1,123ms → 879ms (1.28×), closure-storm 1,135ms → 1,029ms (1.10×).

**Done** (map/collection, Feb 2026): `append` (2-arg), `get` (2-arg), `contains?` (2-arg) — 3 more opcodes (`Append`, `Get`, `ContainsQ`).

**Done** (string ops, Jun 2026): `string-length`, `string-ref`, `string-append` (2-arg) — opcodes `StringLength`/`StringRef`/`StringAppend`. Char-indexed, semantics identical to the stdlib fns; redefinition guard respected; N-ary `string-append` stays generic. **No measurable suite impact** — none of the current benchmarks exercise these in a hot path (`string-pipeline`/1BRC use slash-namespaced `string/split` + `string->float`). They help user code that hammers the legacy names; the win is latent here.

**Remaining** — extend to misc operations:
- Misc: `apply`, `display` (control-flow/IO — trickier, deferred)
- `substring` skipped: 2-or-3-arg optional arity doesn't map to a fixed-pop stack opcode

This is what Lua's VM does — `OP_GETTABLE`, `OP_CONCAT`, `OP_LEN` etc. are inline opcodes, not function calls.

### 2. Replace Rc with a tracing GC ❌ (superseded)

**Impact:** Estimated ~1.3× speedup
**Effort:** Large (weeks)
**Status:** ❌ Superseded (Jul 2026). The Rc + COW architecture stays. Two cheaper mechanisms captured the win this item promised: `TakeLocal` (the compiler moves a local's statically-last use instead of cloning it) plus the owned-args callback protocol let fold accumulators reach the stdlib COW gates with refcount 1, so immutable-update hot loops mutate in place; and the `mutable-array`/`bytes` APIs let byte-oriented workloads opt out of value churn entirely. A tracing GC would also conflict with the shipped CORE-2 cycle collector (ADR #66) and the `Rc`-uniqueness COW gates those wins rely on.

The architectural change that would close the gap to Janet. Every `Value::clone()` and `Value::drop()` currently touches the refcount (cache-unfriendly). A simple mark-and-sweep GC (like Janet's) makes value copies free (just copy 8 bytes of NaN-boxed `u64`) and batches deallocation.

The NaN-boxed `u64` representation is already perfect for this — the 6-bit tag tells you whether the 45-bit payload is a GC pointer. The `ValueView` enum would still work for pattern matching; only the memory management changes.

Considerations:
- Sema is currently single-threaded (`Rc`, not `Arc`) — a simple non-concurrent GC is fine
- Cycles are not handled by `Rc` today (not a practical issue yet, but GC solves it for free)
- GC pause latency may matter for interactive/streaming use cases — generational GC could help
- This is the single biggest architectural bottleneck but also the most invasive change

### 3. Stack-allocated strings for short-lived intermediates

**Impact:** Estimated ~1.2× on I/O-heavy workloads
**Effort:** Medium (days)

In the 1BRC hot loop, `string/split` creates 2 temporary `Rc<String>` per line that are immediately consumed and dropped. An arena or bump allocator for strings that don't escape the current call frame would eliminate millions of `Rc` alloc/dealloc pairs.

Options:
- Bump allocator per VM `run()` invocation, reset on return
- Small-string optimization (inline strings ≤ 22 bytes in the `Value` payload directly)
- `bumpalo` for temporaries with explicit escape-to-heap promotion

## Tier 2: Moderate Wins (1.3–2× additional)

### 4. Computed goto / direct threading for VM dispatch

**Impact:** Estimated 15–30% on tight loops
**Effort:** Small–Medium

The current `match op { ... }` compiles to a jump table, but each iteration re-enters the match. With direct threading (jump directly to the next handler's address), you eliminate the central dispatch. Lua, CPython, and most production VMs do this.

Rust doesn't natively support computed goto, but options exist:
- `unsafe` with function pointer table
- C shim for the dispatch loop
- Wait for Rust's `#[feature(label_break_value)]` or similar

### 5. Constant folding and dead code elimination in the compiler ✅ (partial)

**Impact:** Compile-time savings; runtime impact negligible on current benchmarks (hot loops use variables, not constants)
**Effort:** Medium
**Status:** Done (Feb 2026). Optimizer pass (`optimize.rs`) runs between lowering and resolution.

Implemented:
- Fold constant arithmetic: `(+ 1 2)` → `3`, `(* 3 4)` → `12`
- Fold constant comparisons: `(< 1 2)` → `#t`
- Boolean simplification: `(not #t)` → `#f`
- If with constant test: `(if #t a b)` → `a`
- And/Or simplification with constant operands
- Dead constant elimination in `begin` blocks

Remaining:
- Propagate known constants through `let` bindings
- Eliminate unused bindings
- Strength reduction: `(* x 2)` → `(+ x x)`

### 6. Register-based VM instead of stack-based

**Impact:** Estimated 20–40% fewer instructions
**Effort:** Large (rewrite of VM)

Stack VMs are simpler but generate more push/pop traffic. A register VM (like Lua 5.x, Janet) encodes source/destination registers in the opcode, reducing stack manipulation. The tradeoff is wider instructions (3–4 byte operand fields instead of 0–2).

This would be a full rewrite of `crates/sema-vm/src/vm.rs` and the emitter. Consider only if the stack VM hits a ceiling after other optimizations.

## Tier 3: Smaller Wins (10–30%)

### 7. Inline caching for global lookups ⚠️ (tested, reverted)

**Impact:** Negative — 2.4× regression with Knuth multiplicative hash; neutral with 256-entry cache
**Effort:** Small–Medium
**Status:** Tested (Feb 2026). Expanding to 256 entries with Knuth hash caused catastrophic cache misses on deriv (879ms → 2,123ms). Reverted to original 16-entry direct-mapped cache.

The VM has a 16-entry direct-mapped `global_cache` that works well for the current workloads. The Spur bit distribution already maps cleanly to the 16 slots. Per-callsite IC (storing cache data alongside bytecode) remains a potential improvement but requires a different approach — either embedding IC indices in the instruction encoding or using a side table keyed by `(function_id, pc)`.

### 8. Specialize hot higher-order functions

**Impact:** 10–20% on functional-style code
**Effort:** Medium

`file/fold-lines`, `map`, `filter`, `reduce` are the hottest higher-order functions. The VM could recognize these patterns and:
- Keep the closure's call frame alive across iterations (avoid per-call frame setup/teardown)
- Reuse the argument slots instead of pushing/popping
- Fuse map+filter chains into a single loop

### 9. String interning for string values ✅

**Impact:** O(1) equality for interned strings (pointer comparison via existing NaN-boxed fast path)
**Effort:** Small
**Status:** Done (Feb 2026). Added `string/intern` function with thread-local intern table.

Implemented as opt-in `(string/intern s)` — returns a string Value backed by a shared `Rc<String>` from a thread-local intern table. Two calls with the same content return the same `Rc` pointer, making `Value::eq` O(1) via the existing raw-bits fast path. Useful for map keys in hot loops (e.g., 1BRC station names).

## What Closed the Gap to Janet (Jul 2026)

Janet was ~1.6× ahead on 1BRC-optimized at the start of the July 2026 campaign; Sema ended it ahead on every benchmark (see Current State). What actually did it, with measured per-item impact (plain-release A/B unless noted):

| Change | Measured impact | Where |
| --- | --- | --- |
| Byte-oriented 1BRC on `mutable-array`/`bytes` APIs | −48% 1BRC-opt | benchmark + new stdlib/heap types |
| `TakeLocal` + owned-args protocol (COW unlock) | −38% 1BRC-simple | compiler + VM + stdlib folds |
| `CallSelf` (+ tail form) for top-level self-recursion | −25% tak | compiler + VM |
| SmallVec native-call arg buffers | −8–11% 1BRC | VM |
| `run_inner` monomorphized over debug mode | −11–13% tak | VM |
| `MutArrGet`/`MutArrSet` intrinsics | −10% 1BRC-opt | compiler + VM |
| `string->number` fast decimal parse | −10% 1BRC-simple | stdlib |
| Self-tail-call on internal defines | −4% nqueens | resolver |
| Single-allocation strings (`Value::string_owned`) | −1.5–4% | core + VM + stdlib |

Direct threading (#4), register VM (#6), quickening (#14), and the JIT (#15) remain unexplored headroom — the dispatch preamble was still ~23% of tak's profile before `CallSelf` reduced the call count.

## Tier 4: Build & Compiler Tuning (Free Wins)

### 10. LTO "fat" for release builds

**Impact:** Measured 3–9% (1BRC −3%, tak −7%, several −8–10%; mandelbrot is noisy ±5%)
**Effort:** Trivial (one-line change)
**Status:** ✅ Done (Jun 2026) — `lto = "fat"` on `[profile.release]` + `[profile.dist]`. Shippable; only cost is compile time (~71s thin → ~2.5min fat).

The VM dispatcher in `sema-vm` calls into `sema-core` value operations (`view()`, `try_as_small_int()`, `as_int()`) millions of times per benchmark. With thin LTO, LLVM can't always inline across crate boundaries. Fat LTO (`lto = "fat"`) enables full cross-crate inlining at the cost of slower compile times. The `dist` profile should also be upgraded.

### 11. `target-cpu=native` for local benchmarking

**Impact:** Measured **no-op** on this workload — dispatch is branch-bound, not SIMD-bound, and generic aarch64 already uses NEON on Apple Silicon.
**Effort:** Trivial (RUSTFLAGS)
**Status:** ⚠️ Tested (Jun 2026), not pursued — zero measurable gain, and it breaks portable/distributable binaries. Keep it out of release builds.

Building with `RUSTFLAGS="-C target-cpu=native"` lets LLVM use the full instruction set of the host CPU (e.g., Apple Silicon NEON, AVX2 on x86). Not suitable for distributed binaries, but should be standard practice for local benchmarking. Can be added to `.cargo/config.toml` under a `[target]` profile or a jake benchmark recipe (jake/bench.jake).

### 12. `#[inline(always)]` audit on hot Value accessors

**Impact:** No measurable suite impact — the hot path was already inlined.
**Effort:** Small (hours)
**Status:** ✅ Done (Jun 2026, shipped v1.19.2). Most hot accessors were already `#[inline(always)]`; added it to `type_name` + `as_str`. (`try_as_small_int`/`is_immediate` don't exist — small-int decode lives inline in `as_int`/`as_float`/`view`, which is deliberately NOT force-inlined as it's a large refcount-bumping match.)

Ensure the hottest `Value` methods are `#[inline(always)]`: `as_int()`, `as_float()`, `is_truthy()`, `view()`, `raw_tag()`, `type_name()`. Without this annotation, LLVM may choose not to inline across crate boundaries even with LTO, especially for methods called from tight loops in `sema-vm`. Verify with `cargo-asm` or `samply` that these are actually inlined in the dispatch loop.

### 13. Profile-Guided Optimization (PGO)

**Impact:** Measured **−11% to −40%** (1BRC −25%/−27% best, higher-order-fold −40%, tak −32%, mandelbrot −29%, deriv/hashmap/bench-features ≈ −21–22%). The single biggest free win — it reorders the `match op` dispatch hot blocks by real opcode frequency.
**Effort:** Medium (set up PGO pipeline)
**Status:** ✅ Shipped in v1.19.2 (Jun 2026) — wired into cargo-dist release CI via dist's `github-build-setup` (`.github/pgo-setup.yml`), and runnable locally with `jake build-pgo` (`scripts/pgo-build.sh`). Pipeline: `cargo build` with `-C profile-generate` → run the **full** bench suite + 1BRC as training → `llvm-profdata merge` (binary lives in the rustlib bin dir, not PATH) → rebuild with `-C profile-use`. PGO runs on native release targets only; cross-compiled `aarch64-linux` and Windows fall back to fat LTO (POSIX-path/MSVC quirk), and the step is fail-safe (any failure ships LTO, never breaks the release). **Train on a representative corpus**: a partial corpus regressed `bench-features` +29%; full-suite training fixed it (→ −21%, no regressions). Validated green across all 5 targets via a CI smoke test (`pr-run-mode=upload` on a throwaway branch, no publish) — which caught two real bugs (libudev dep ordering on Linux; Windows path) before they shipped. `cargo install` builds get fat LTO but not PGO (PGO needs the training step).

Use Rust's PGO support (`-C profile-generate` / `-C profile-use`) with representative Sema benchmarks (tak, 1BRC, deriv) as the training workload. This lets LLVM:
- Lay out the dispatch function's basic blocks optimally for actual opcode frequency
- Apply branch prediction hints matching real usage patterns
- Inline decisions based on measured call frequency

Pipeline: build with instrumentation → run benchmarks → merge profiles → rebuild with `-C profile-use`. Can be integrated into CI for release builds. See [rustc PGO docs](https://doc.rust-lang.org/rustc/profile-guided-optimization.html).

## Tier 5: Speculative / Research (Long-Term)

### 14. Quickening (speculative type specialization)

**Impact:** Estimated 20–40% on type-stable hot loops
**Effort:** Large (weeks)
**Status:** Research

After first execution, rewrite generic opcodes with type-specialized versions based on observed operand types. For example, if `Add` always sees two `IntSmall` values, rewrite it in-place to `AddInt` which skips the type check and NaN-unboxing. If the type guard fails at runtime, deoptimize back to the generic version.

This is essentially what CPython 3.11+ does with its "specializing adaptive interpreter." Key design decisions:
- **Granularity:** Per-instruction (CPython) vs per-basic-block
- **Deoptimization:** Rewrite back to generic op on guard failure, with a counter to avoid re-specializing thrashing call sites
- **Mutable bytecode:** Requires `Chunk.code` to be mutable at runtime (currently `Vec<u8>`, so this works)
- **Interaction with superinstructions:** Quickened ops can themselves be fused into super-quickened pairs

Prerequisite: instruction frequency profiling (superinstructions Phase 3) to identify which opcodes are worth specializing.

### 15. Copy-and-patch JIT

**Impact:** Estimated 3–5× over interpretation
**Effort:** Very large (months)
**Status:** Research

A lightweight JIT approach that avoids the complexity of a full compiler backend. Pre-compile native code "stencils" for each opcode at build time (using `cc` or `include_bytes!` with precompiled blobs), then at runtime `memcpy` them into an executable buffer and patch operand slots (register indices, constants, jump targets).

This gets native-code performance without a full Cranelift/LLVM JIT integration. References:
- Xu & Kjolstad, *Copy-and-Patch Compilation* (OOPSLA 2021)
- CPython 3.13's copy-and-patch JIT implementation
- Haas's *Copy-and-Patch for Lua* experiments

Considerations for Sema:
- Rust's `mmap` + `mprotect` for executable memory (or use the `region` crate)
- Stencils would be architecture-specific (`aarch64` for Apple Silicon, `x86_64` for Linux/CI)
- NaN-boxed `Value(u64)` fits in a single register, making stencils simpler than tagged-pointer schemes
- Could target only hot loops (detected via execution counter) rather than whole-program compilation

This would move Sema from the "fast interpreter" tier into the "JIT-compiled" tier, potentially competitive with LuaJIT's interpreter mode (though not its tracing JIT).

## What's Not Realistic

Catching SBCL (1.0×) or Chez Scheme (1.3×) is not possible without a native code compiler. Those implementations compile Lisp to machine code — `(+ x y)` becomes an `ADD` instruction. No amount of VM optimization can match that. A copy-and-patch JIT (§15) could close the gap to ~2–3× behind SBCL, but a full tracing JIT (like LuaJIT) is a multi-year project and changes the character of the language.

## Previously Tried and Rejected

| Approach | Result | Why |
| --- | --- | --- |
| HashMap for Env | Slower | `BTreeMap` is faster for small maps (1–3 entries) typical of `let` scopes |
| im-rc / rpds (persistent collections) | Slower | Structural sharing fights COW — the point is to mutate in place when refcount is 1 |
| bumpalo / typed-arena | Incompatible | Values need to escape the arena (returned from functions, stored in envs) |
| compact_str / smol_str | Redundant | Symbols/keywords are already interned as `Spur`; string values aren't in the dispatch hot path |
| Mini-eval (inlined evaluator in stdlib) | Removed | 3× faster but caused semantic drift and blocked the bytecode VM |
