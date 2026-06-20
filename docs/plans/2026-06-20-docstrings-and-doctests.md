# Docstrings & Doctests

**Date:** 2026-06-20
**Status:** Proposed — deterministic salvage from the retired Living Code design (`docs/design/living-code.md` layers 0–1). The LLM layers (3–6) are killed (`docs/deferred.md` "LC"); Layer 2 (`read-source`/directives) is deliberately **out of scope** (reader surgery + source-text storage for speculative demand).

**Goal:** Runtime docstrings on user functions (`doc` / `meta`) and a deterministic doctest runner (`sema test --doctests`). No LLM, no self-modification — just the table-stakes introspection every serious language ships.

## Why this is worth it

- **Deterministic.** A doctest `>>> (f 2)` → `4` is an ordinary test. None of the non-determinism that doomed `evolve`/`heal!`.
- **Precedent + demand.** Python/Elixir/Rust doctests are beloved. Sema already invests heavily in docs (the `sema-docs` crate, LSP hover, the website) — this is the runtime side of that proven demand.
- **Small, and it fits the existing grain.** The VM's `Function` (`crates/sema-vm/src/chunk.rs:49`) already carries serialized compile-time metadata (`source_file`, `local_names`, `local_scopes`). A `doc` field is the same pattern.

## Scope

### Layer 0 — docstrings (effort: S)

1. **`Function.doc: Option<String>`** in `crates/sema-vm/src/chunk.rs`. Mirror how `source_file`/`local_scopes` are handled.
2. **Lowering** — in `lower_define`/`lower_defn` (`crates/sema-vm/src/lower.rs:139`, `:474`): when the first body form (after the signature) is a string *and* there is at least one more body form, treat it as the docstring rather than a return value. (Guard the single-form case: `(define (f) "just a string")` must still return the string.)
3. **`.semac` format bump** — add `doc` to `serialize_function` / deserializer in `crates/sema-vm/src/serialize.rs` **and** update `website/docs/internals/bytecode-format.md` (hard rule in CLAUDE.md). Bump format version.
4. **Stdlib** — `(doc f)` pretty-prints name/arity/doc; `(meta f)` returns a map `{:name :doc :params :arity :file}` (all already on `Function`). Register in a stdlib module, add dual-eval tests.

### Layer 1 — doctests (effort: M)

5. **Parser** — pure fn `parse_doctests(&str) -> Vec<DocTest>`. Markers: `>>>` (eval), next non-blank line (expected, compared `equal?`), `!! substring` (expected error), `~>` (expected stdout), `>>>!` (setup, unchecked). Unit-tested in isolation.
6. **Runner** — eval each `>>>` in a fresh child env via the existing eval entry point, capture result/error/stdout, compare. Reuses `set_stdout_hook` for `~>`.
7. **CLI** — net-new `sema test` subcommand (clap) in `crates/sema/src/main.rs` — **none exists today**. `--doctests [FILE]` walks files, finds documented defs, runs their doctests, reports `name … n/n ✓`. `-v` shows each example.
8. **Decision to make first:** do doctests run through the dual-eval harness like other tests? Default yes, for consistency with `dual_eval_tests!`.

## Out of scope (explicitly)

- `read-source`, `source-of`, `;;@directives` (Layer 2) — needs a new reader mode (parser currently *skips* `Token::Comment`, `crates/sema-reader/src/reader.rs:36`) and per-function source-text storage the VM lacks. Revisit only if a concrete consumer appears.
- All LLM layers (`ask`/`heal!`/`evolve`/`become!`) — killed, see `docs/deferred.md`.

## Done When

- `(define (f x) "doc" x)` then `(doc f)` / `(meta f)` work on the VM, dual-eval tested.
- `doc` round-trips through `.semac` (serialize test + `bytecode-format.md` updated).
- `sema test --doctests <file>` runs `>>>` examples and reports pass/fail; covers value / `!!` error / `~>` stdout markers.
- Single-form `(define (f) "x")` still returns `"x"` (no docstring false-positive).
