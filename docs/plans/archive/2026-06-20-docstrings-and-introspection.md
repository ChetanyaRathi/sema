# Docstrings & Introspection

> 🅿️ **PARKED (2026-06-20) — cut for maintainability, not implemented.** A
> feasibility pass confirmed this is *clean* to build (docstring rides the VM
> `Function` metadata + `.semac` string table exactly like `name`/`local_scopes`;
> no source-text drag; binary path inherits it free via the shared deserialize).
> But with doctests and the LLM layers already gone, `doc`/`meta` alone wasn't
> worth the standing maintenance (a `.semac` format-version bump + ~10 `Function`
> construction sites + serialize round-trip to carry forever). Parked as a clean,
> well-scoped plan to revisit if a concrete need appears. The feasibility notes
> below are preserved so a future pass starts warm.

**Date:** 2026-06-20
**Status:** Parked — cut for maintainability 2026-06-20 (revisit later). Deterministic salvage from the retired Living Code design (`docs/design/living-code.md` layer 0). Doctests (layer 1) and `read-source` (layer 2) were already out of scope.

**Goal:** Runtime docstrings on user functions, queryable via `doc` / `meta`. A small language feature that just adds polish — no LLM, no test runner, no self-modification.

## Why this is worth it

- **Tiny and fits the existing grain.** The VM's `Function` (`crates/sema-vm/src/chunk.rs:49`) already carries serialized compile-time metadata (`source_file`, `local_names`, `local_scopes`). A `doc` field is the same pattern.
- **Proven demand.** Sema already invests heavily in docs (the `sema-docs` crate, LSP hover, the website). Runtime `doc`/`meta` is the in-language side of that — and the LSP/REPL can surface a user function's own docstring on hover.
- **Deterministic.** None of the non-determinism that doomed the LLM layers.

## Scope (layer 0 only)

1. **`Function.doc: Option<String>`** in `crates/sema-vm/src/chunk.rs`. Mirror how `source_file`/`local_scopes` are handled.
2. **Lowering** — in `lower_define`/`lower_defn` (`crates/sema-vm/src/lower.rs:139`, `:474`): when the first body form (after the signature) is a string *and* there is at least one more body form, treat it as the docstring rather than a return value. **Guard the single-form case:** `(define (f) "just a string")` must still return the string.
3. **`.semac` format bump** — add `doc` to `serialize_function` / deserializer in `crates/sema-vm/src/serialize.rs` **and** update `website/docs/internals/bytecode-format.md` (hard rule in CLAUDE.md). Bump format version.
4. **Stdlib** — `(doc f)` pretty-prints name/arity/doc; `(meta f)` returns a map `{:name :doc :params :arity :file}` (all already on `Function`). Register in a stdlib module, add dual-eval tests.

## Out of scope (explicitly)

- **Doctests (`sema test --doctests`)** — YAGNI (decided 2026-06-20). It's a net-new CLI subcommand + runner + a dual-eval decision to maintain, and it only earns its keep if doctests actually get written. The `Function.doc` field added here is the prerequisite, so this stays cheaply reachable if that ever changes.
- **`read-source` / `source-of` / `;;@directives`** (layer 2) — needs a new reader mode (parser currently *skips* `Token::Comment`, `crates/sema-reader/src/reader.rs:36`) and per-function source-text storage the VM lacks, for speculative demand.
- **LLM layers** (`ask`/`heal!`/`evolve`/`become!`) — killed, see `docs/deferred.md`.

## Done When

- `(define (f x) "doc" x)` then `(doc f)` / `(meta f)` work on the VM, dual-eval tested.
- `doc` round-trips through `.semac` (serialize test + `bytecode-format.md` updated).
- Single-form `(define (f) "x")` still returns `"x"` (no docstring false-positive).
