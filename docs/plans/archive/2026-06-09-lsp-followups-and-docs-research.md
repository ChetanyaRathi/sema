# LSP Follow-ups + Docs-Resolving Research

**Date:** 2026-06-09
**Scope:** Formatting/linting sweep results, the LSP builtin-docs resolving mechanism (how it works + bugs), and feasibility of three deferred follow-ups (range/on-type formatting, user-defined docstrings, DAP server capabilities).
**Exclusions:** `brand/` and the vendored `benchmarks/1brc/sema-src` copy were skipped (neither is a workspace member).

---

## 1. Formatting / Linting Sweep — Results

### 1.1 `cargo fmt`

- `cargo fmt` exit 0; `cargo fmt -- --check` exit **0 (clean)**.
- **Files reformatted: ZERO.** The workspace was already fmt-clean. Verified two ways: (1) `--check` passes, (2) `find crates editors -name '*.rs' -newermt '-3 minutes'` returned 0 files, so `cargo fmt` wrote nothing.
- The 7 pre-existing dirty `.rs` files (`sema-core/lib.rs`, `sema-dap/server.rs`, `sema-lsp/lib.rs`, `sema-stdlib/io.rs`, `sema-stdlib/stream.rs`, plus untracked `output_hook.rs` and `lsp_e2e_test.rs`) were already fmt-conformant from prior work; fmt did not touch them.

### 1.2 Clippy findings per crate (before → after auto-fix)

Command used: `cargo clippy --workspace --all-targets -- -D warnings`.

**Key structural finding:** the Makefile gate (`make clippy`, lines 33–34) runs `cargo clippy -p <crate> ... -- -D warnings` with **no `--all-targets`**, so it lints lib+bins only and **never sees `#[cfg(test)]` code**. Every finding below lives in test modules / test files — that is why they were invisible to the gate. They are **not regressions**; they were newly surfaced because this sweep added `--all-targets`.

**Crates the Makefile omits entirely (`sema-lsp`, `sema-dap`, `sema-fmt`, `sema-notebook`): CLEAN** under `--all-targets -- -D warnings`, exit 0, zero warnings — both before and after.

#### Before (per crate, `--all-targets`)

| Crate | Errors | Lints |
|---|---|---|
| sema-core | 8 | 6× `approx_constant`, 1× `bool_assert_comparison`, 1× `unnecessary_get_then_check` |
| sema-reader | 2 | 2× `approx_constant` |
| sema-vm | 5 | 4× `approx_constant`, 1× `iter_cloned_collect` |
| sema-llm | 2 | 1× `items_after_test_module`, 1× `explicit_auto_deref` |
| sema-lang (binary, `crates/sema/`) | ~12 | 10× `approx_constant`, 1× `needless_borrows_for_generic_args` (only non-test src: `import_tracer.rs:404`), + `manual_range_contains`, `bool_comparison`, `len_zero`, `expect_fun_call` across integration tests |
| sema-eval, sema-stdlib, sema-wasm | 0 | clean |
| sema-lsp, sema-dap, sema-fmt, sema-notebook | 0 | clean (omitted from gate but fine) |

#### Auto-fix applied

`cargo clippy --fix --workspace --all-targets --allow-dirty` (exit 0). **10 files fixed:** `value.rs` (1), `builtins.rs` (2), `vm.rs` (1), `import_tracer.rs` (1), `http_test.rs` (1), `integration_test.rs` (6), `llm_test.rs` (1), `pio_cross_validation_test.rs` (1), `server_test.rs` (2), `vm_integration_test.rs` (5).

All changes are mechanical: `assert_eq!(x, false)` → `assert!(!x)`, `.iter().cloned().collect()` → `.to_vec()`, `&[..]` → `[..]`, `Value::keyword(*k)` → `(k)`, relocate `detect_media_type` before its test mod. **No production logic touched** — every change is test code or a pure code move. Diffstat: 36 insertions, 37 deletions across 10 files.

#### After auto-fix — remaining manual issues

All remaining failures are unfixable-by-design and live in test code. The bulk is `approx_constant` firing on the **literal `3.14`** in test assertions — these deliberately test that `3.14` round-trips through float parse/serialize, so rewriting to `std::f64::consts::PI` would change the test's meaning.

- `clippy::unnecessary_get_then_check` — `crates/sema-core/src/context.rs:435` (test; `cached.get("old").is_none()` → `!cached.contains_key("old")`; not auto-applied — likely a fresh test edit, safe one-liner)
- `clippy::approx_constant` (literal `3.14`, all in tests):
  - `crates/sema-core/src/json.rs:214`, `:217`
  - `crates/sema-core/src/value.rs:2462`, `:2463`, `:2620` (×2)
  - `crates/sema-reader/src/reader.rs:719`, `:1184`
  - `crates/sema-vm/src/emit.rs:159`, `:160`
  - `crates/sema-vm/src/serialize.rs:1896`, `:1921`
  - `crates/sema/tests/dual_eval_types_test.rs:110`, `dual_eval_stdlib_test.rs:335`, `dual_eval_test.rs:754`
  - `crates/sema/tests/integration_test.rs:309, 1433, 1775, 2574, 4072, 10618`
- `clippy::dead_code` — `crates/sema/tests/common/mod.rs:5` (`eval_tw`), `:13` (`eval_vm`) — benign per-test-binary false positive (helpers used by some test files, not all); surfaces only under `--all-targets`.

**Recommendation:** these are all test-only and harmless. To get a zero-warning `--all-targets` gate, the cleanest fix is `#![cfg_attr(test, allow(clippy::approx_constant))]` (or per-module `#[allow]`) on the affected test modules rather than rewriting literals. Optionally apply the single `context.rs:435` and `common/mod.rs` cleanups.

### 1.3 Tests / compile confirmation

- **`cargo test -p sema-lsp`: PASS** (exit 0) — 190 + 1 + 0 tests, 0 failed. Prior LSP work (incl. new `crates/sema-lsp/tests/lsp_e2e_test.rs`) intact.
- **`cd editors/intellij && ./gradlew compileKotlin`: BUILD SUCCESSFUL** (exit 0, ~8s).
- `cargo fmt -- --check` still exit 0 after all autofixes.

### 1.4 Kotlin / JS tooling gap (recommendation only — no action taken)

- **No Kotlin formatter/linter configured.** Zero matches for `ktlint|spotless|detekt|ktfmt` in `editors/intellij/build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`.
- **No JS lint/format scripts** in the real JS areas: `website`, `playground`, `crates/sema-notebook/tests/e2e`, `editors/vscode/sema` all have `package.json` but **no** `lint`/`fmt`/`format`/`prettier` scripts (nor does `editors/intellij/package.json`).
- **Recommendation (config decision, out of scope for the sweep):** if consistency is wanted, add Spotless + ktlint to the IntelliJ Gradle build and a Prettier `format` script to the JS packages.

### 1.5 Makefile gate gap (the actionable structural takeaway)

The clippy gate misses two things that this sweep exposed:
1. **No `--all-targets`** → test code is never linted by `make clippy`.
2. **4 crates omitted** (`sema-lsp`, `sema-dap`, `sema-fmt`, `sema-notebook`) — they happen to be clean, but they are not gated.

Tightening the gate is a small Makefile change; pair it with the `approx_constant` test-allow above so the stricter gate stays green.

---

## 2. LSP Docs-Resolving — How It Works

The doc machinery lives in `crates/sema-lsp/src/builtin_docs.rs` and is consumed throughout `crates/sema-lsp/src/lib.rs`.

### 2.1 `build_builtin_docs()` — the two doc sources

`build_builtin_docs()` (`builtin_docs.rs:40`) merges two sources into a single `HashMap<String, String>` (`self.builtin_docs`):

1. **stdlib-md** — parsed from 22 `website/docs/stdlib/*.md` files via `include_str!` (the `sources` array, `builtin_docs.rs:43–70`), each run through `parse_stdlib_md`. Includes `define-record-type` (from `records.md`).
2. **inline `special_forms`** — a hard-coded table of special-form name → markdown (`builtin_docs.rs:73–115`, 41 entries).

### 2.2 `parse_stdlib_md(md, out)` — the parsing contract

`parse_stdlib_md` (`builtin_docs.rs:5–37`) walks the file line-by-line and recognizes exactly one heading shape:

```rust
if let Some(rest) = lines[i].strip_prefix("### `") {
    if let Some(name) = rest.strip_suffix('`') {
        let name = name.to_string();
```

Precise contract:

- **Heading must be `### ` + backtick + name + backtick with NOTHING after the closing backtick.** The key is the literal text between the backticks. `strip_suffix('`')` requires the line to *end* with a backtick, so any trailing text (`, ...`, a space, a paren) makes the heading fail to match and the entire section is dropped.
- After a matched heading: skip blank lines (lines 14–17), then **collect every subsequent line verbatim** (lines 20–27) until the next line that `starts_with("### ")` or `starts_with("## ")`. Everything in between — prose, code fences, bullet lists, tables, VitePress `:::` containers — is concatenated raw into the doc body.
- `### ` and `## ` (with trailing space) both terminate a section. A bare `###`/`##` with no trailing space would NOT terminate (a latent edge, not currently hit).
- Empty bodies are dropped (lines 28–31: `if !doc.is_empty()`).
- **Last-write-wins:** `out.insert(name, doc)` — a name appearing in two files (or twice in one file) silently overwrites.

The intended format (per the line-4 comment): `### \`name\`` then a description paragraph then a ```` ```sema ```` example — one clean `### \`fn\`` per function with pure backtick headings.

### 2.3 Consumption paths in `lib.rs`

`build_builtin_docs()` feeds every doc-bearing LSP feature:

| Feature (lib.rs) | Special forms | Builtins | User-defs | Imported defs |
|---|---|---|---|---|
| **completion** (`handle_complete`, `1941`) | KEYWORD items; doc inlined from `builtin_docs` (`1966`); none → `documentation: None`. | FUNCTION items; doc inlined (`1985`); none → bare. | FUNCTION items; `detail` = params from AST (`2003`), `data` = uri for resolve (`2008`); no `documentation` (deferred). | Not offered (only current-doc user defs + scope-tree locals at `2018`). |
| **completion-resolve** (`handle_completion_resolve`, `2035`) | Fallback fill from `builtin_docs` (`2040`) if not already inlined. | Same `builtin_docs` fallback (`2040`). | Fills `documentation` from `user_definition_signature` (`2049`) via `data` uri hint, then any open doc (`2074–2086`). | Not handled — no resolution path. |
| **hover** (`handle_hover`, `2385`) | 1st: `builtin_docs` (`2397`); fallback bare `*Special form*` if in `SPECIAL_FORM_NAMES` (`2436`). | `builtin_docs` (`2397`); fallback bare `*Built-in function*` (`2447`). | Signature + `*User-defined*` (`2418–2431`). | Signature + `*Imported from X*` (`2481–2486`). |
| **signature help** (`~2840`) | n/a (skipped) | `builtin_docs` doc, no param highlight (`2840`). | param-highlighted sig from AST. | param-highlighted sig from import cache (`2815`). |
| **inlay hints** (`3348` / `resolve_param_names_immut` `3492`) | skipped (`3411`). | params parsed from `builtin_docs` body (`3532`). | params from AST. | params from import cache. |
| **semantic tokens** (`2902`) | uses `SPECIAL_FORM_NAMES` / `builtin_names` only, no docs. | same. | n/a | n/a |

The same map is also reused outside the LSP by the REPL `,doc` command (`crates/sema/src/repl/commands.rs`), which calls `sema_lsp::builtin_docs::build_builtin_docs()` for builtin/special-form text.

---

## 3. LSP Docs-Resolving — Problems Found

### 3.1 Parser-correctness bugs (broken / empty entries)

**A. `lists.md` — entire `cadr`/`caddr` family produces NO entry (12 functions undocumented).**
`lists.md:67` is `### \`cadr\`, \`caddr\`, ...`. The line does not end in a backtick, so `strip_suffix('`')` returns `None` and the heading is skipped entirely. Verified by running the parser: `cadr present? False | caddr present? False`. The documented functions `caar, cadr, cdar, cddr, caaar, caadr, cadar, caddr, cdaar, cdadr, cddar, cdddr` (named in the body) get **zero** hover docs. This is the clearest parser-correctness bug among the audited files.

**B. `regex.md` — VitePress `:::` container directives leak into hover.**
`regex/match`'s body ends with a raw VitePress container (`regex.md:76–78`):

```
::: info Byte offsets
`:start` and `:end` are byte offsets (UTF-8). For ASCII text they match character indices, but for non-ASCII they may differ.
:::
```

LSP clients render `textDocument/hover` as plain Markdown, so `::: info ... :::` shows up verbatim (the `:::` lines and the `info` token are not stripped). Same leak occurs wherever a `:::` block falls inside a function section.

**C. `http-json.md` — bare ```` ``` ```` signature fences + silently-dropped content.**
Only 8 entries extracted (`http/get http/post http/put http/delete http/request json/encode json/encode-pretty json/decode`). Each body **begins with an unlabeled code fence** holding the signature (e.g. for `http/get`):

```
```
(http/get url)
(http/get url opts)
```

Make an HTTP GET request.
```

The signature lives in a bare ```` ``` ```` fence (not ```` ```sema ````), unlike math/strings/lists/maps where the description comes first — so it renders untyped/uncolored and the description is buried below it (inconsistent hover formatting). Bare signature fences are at `http-json.md:54, 75, 105, 123, 140, 272, 302, 325`. Substantial content under non-backtick `### ` headings is silently dropped: `### Response Map`, `### Options Map`, `### Error Handling`, `### Common Patterns`, `### Type Mapping`, `### JSON Roundtrips`. The Response/Options Map tables (explaining `:status`/`:headers`/`:body`/`:timeout`) never reach any function's hover.

**D. Duplicate keys across files (silent last-write-wins) — concrete `assoc` collision.**
`assoc` appears in both `lists.md:95` (assoc-list lookup) and `maps.md:41` (map insert). Because `maps.md` is included *after* `lists.md` in `sources` (lines 47 vs 46), the **map `assoc` overwrites the list `assoc`** — hovering `assoc` in a list context shows the map doc. Any name in two namespaced files has the same risk (reordering `sources` is not a real fix since both are legitimate).

**E. Cosmetic / stylistic inconsistency.**
`regex/match` and `regex/replace` carry a `**Signature:** \`...\`` line (`regex.md:50, 95`), a style absent from math/strings/lists/maps. `records.md`'s `define-record-type` body is all narrative + two ```` ```sema ```` blocks and uses a `<type-name>` angle-bracket template (fine as Markdown, just not a normal example).

**F. `records.md` is 95% conceptual.**
Only `define-record-type`, `record?`, `type` are extracted. This is arguably correct (per-record helpers like `make-point`, `point?`, `point-x` are user-defined, not builtins) — flagged only because readers may expect the helpers to be documented.

**G. No empty-doc failures in the seven audited files**, but the `!doc.is_empty()` guard means any future `### \`fn\`` immediately followed by another heading vanishes without warning. The existing test `parse_stdlib_md_basic` (`builtin_docs.rs:128–149`) covers only the happy path and would catch none of A–D.

### 3.2 Special-form coverage gaps

Authoritative list: `crates/sema-eval/src/special_forms.rs:157` (`SPECIAL_FORM_NAMES`, 44 names). Doc table: `builtin_docs.rs:73–115` (41 entries).

**In `SPECIAL_FORM_NAMES` but NO doc anywhere — completion shows bare names:**
`async`, `await`, `defmethod`, `defmulti`, `macroexpand`, `message`, `module` (**7 genuinely missing**). These are pushed as KEYWORD completions (`lib.rs:1961–1975`) and matched by the hover special-form fallback (`lib.rs:2436`), but `builtin_docs.get(name)` returns `None`, so completion/resolve/hover all yield only the bare `*Special form*` placeholder.

- `define-record-type` *looks* missing from the inline table but is actually covered via `records.md` (the md path) — a false-positive gap. The two sources are unreconciled, so a future `records.md` heading rename would silently drop it.
- `progn` (and `def`/`defn`) are deliberately silent aliases (`special_forms.rs:202`) — leave or document as aliases, your call.

**In the doc-entry list but NOT a special form (stale / mis-targeted, 6):**

- `with-budget` (`builtin_docs.rs:113`) — **name mismatch bug.** The real builtin is `llm/with-budget` (`sema-llm/src/builtins.rs:3162`). Keyed as `with-budget`, the doc never matches the real symbol in completion/hover/signature/inlay; the actual `llm/with-budget` gets no doc.
- `for`, `for/list`, `for/map`, `for/filter`, `for/fold` (`builtin_docs.rs:108–112`) — not in `SPECIAL_FORM_NAMES`, not builtins, not prelude macros; handled only as a scope-binding form in `sema-lsp/src/scope.rs:172`. Completion never offers them (it iterates `SPECIAL_FORM_NAMES` + `builtin_names` + user defs). Hover *would* find them (`lib.rs:2397`) if the user already typed the form. **Documented but unsuggestable (asymmetric).**

### 3.3 Consumption-path bugs

**Hover precedence — user redefinitions of builtin names show the builtin doc, not the user signature.** `handle_hover` checks `builtin_docs` *first* (`lib.rs:2397`), before the user-def branch (`2411–2433`). So a user `(define map ...)` (or any redefinition of a builtin/special-form name) hovers to the stdlib doc, not the user's signature. `handle_completion_resolve` has the same hazard ordering (`2040` builtin_docs vs `2049` user sig).

**Imported symbols have no completion-resolve path.** `handle_completion_resolve` (`2035`) handles builtin/special-form (via `builtin_docs`) and current-doc user defs (via `data` uri) but never resolves docs for symbols imported from other modules. Latent, since imported defs aren't offered in completion anyway.

---

## 4. LSP Docs-Resolving — Recommended Improvements

Prioritized; each marked **S / M / L**.

### Parser fixes (highest value first)

1. **[S] Handle headings with trailing text after the function name.** Instead of `strip_suffix('`')` on the whole line, find the *first* closing backtick and treat the rest as ignorable annotation. This recovers the `cadr`/`caddr` family. More robustly: extract every backtick-quoted token in a `### ` heading and register the body under *each* — that documents `caar`, `cddr`, etc. from the single combined heading. (Fixes 3.1-A.)
2. **[S] Strip VitePress container directives before storing.** Drop lines matching `^:::` (opening `::: info|tip|warning|details ...` and closing `:::`). Optionally convert `::: tip Title` into a `> **Title**` blockquote so content survives as valid Markdown. (Fixes 3.1-B and any `:::`-bearing section.)
3. **[M] Detect/handle duplicate keys.** Don't let `maps.md`'s `assoc` clobber `lists.md`'s `assoc` silently — keep the first, merge both bodies (namespace-tagged), or at least log. (Fixes 3.1-D.)
4. **[S] Make empty/dropped-doc cases observable in tests.** Add a test asserting every `### \`x\`` heading yields a non-empty entry, so future regressions surface. (Addresses 3.1-G.)

### Markdown normalization (make the source match the contract)

5. **[M] Normalize signature blocks.** In `http-json.md` convert bare ```` ``` ```` signature fences (lines 54, 75, 105, 123, 140, 272, 302, 325) to ```` ```sema ```` or move them after a one-line description, matching math/strings/lists/maps. Remove or normalize the `**Signature:**` lines in `regex.md:50, 95`. (Fixes 3.1-C, 3.1-E.)
6. **[S] Fix the `cadr` heading at the source** even after the parser fix — prefer one `### \`cadr\`` plus aliases in the body, or separate clean headings, over `### \`cadr\`, \`caddr\`, ...`.
7. **[S] Add audit tests:** a `### \`name\`, alias` case, a `:::` container case, and a duplicate-key case to lock in the fixes.

### Special-form / table fixes

8. **[S] Add inline docs for the 7 undocumented special forms** (`async`, `await`, `defmethod`, `defmulti`, `macroexpand`, `message`, `module`) in `builtin_docs.rs:73–115`. (Fixes 3.2.)
9. **[S] Fix the `with-budget` key** → rename to `llm/with-budget` (`builtin_docs.rs:113`) to match the real builtin. (Fixes 3.2.)
10. **[S] Decide intent for `for`/`for*`.** If user-facing, add them to a list completion iterates (or to `SPECIAL_FORM_NAMES` / the prelude macro registry); otherwise remove the dead doc entries (`builtin_docs.rs:108–112`). (Fixes 3.2.)
11. **[M] Reorder hover precedence** so user/imported defs are checked *before* `builtin_docs` (move the `lib.rs:2397` check below the user-def branch at `2433`). Apply the same precedence to `handle_completion_resolve` (`2040` vs `2049`). (Fixes 3.3.)
12. **[S] Add a special-form coverage test** asserting every `SPECIAL_FORM_NAMES` entry resolves to a non-empty `build_builtin_docs()` entry (or is on an explicit allowlist of intentional silent aliases). Existing tests at `builtin_docs.rs:151–164` only spot-check a handful.
13. **[S] Reconcile the two doc sources** — note in `builtin_docs.rs` that `define-record-type` (and any special form whose doc lives in stdlib md) is covered via the md path, to prevent someone "fixing" a false-positive gap by duplicating it.

### Relevant files

- Parser: `crates/sema-lsp/src/builtin_docs.rs` (`parse_stdlib_md` 5–37; `sources` 43–70; inline table 73–115; test 128–149)
- `website/docs/stdlib/lists.md` (line 67 broken `cadr` heading; `assoc` at line 95)
- `website/docs/stdlib/maps.md` (line 41 `assoc` overwrite)
- `website/docs/stdlib/http-json.md` (bare fences 54, 75, 105, 123, 140, 272, 302, 325)
- `website/docs/stdlib/regex.md` (`:::` at 76–78; `**Signature:**` at 50, 95)
- `website/docs/stdlib/records.md` (3 backtick entries; rest conceptual)
- Consumption: `crates/sema-lsp/src/lib.rs` (completion 1941–2031; resolve 2035–2056; hover 2385–2499 with ordering bug at 2397; signature 2840; inlay 3492–3538; `builtin_names` 1864–1867)
- `crates/sema-eval/src/special_forms.rs:157–206`; `crates/sema-lsp/src/scope.rs:172`; `crates/sema-llm/src/builtins.rs:3162`

---

## 5. Deferred Follow-ups — Feasibility

### 5.1 Range / On-Type Formatting

**Verdict: range formatting — DO IT (S–M). On-type formatting — do it client-side only (S), built on range formatting; do NOT implement server-side on-type.**

#### sema-fmt API facts

> **Note (2026-06-09, post-research):** the API below was consolidated the same day. There is now a single whole-string function configured by an options struct:
>
> ```rust
> pub struct FormatOptions { pub width: usize, pub indent: usize, pub align: bool } // Default = 80/2/false
> pub fn format_source(input: &str, opts: &FormatOptions) -> Result<String, SemaError>
> ```
>
> Everything below about behavior (no range parameter, strict parsing, column-0 output, newline normalization) still holds — mentally substitute `format_source(slice, &FormatOptions { indent, ..Default::default() })` where the text says `format_source_opts(slice, 80, indent, false)`.

`crates/sema-fmt/src/lib.rs` exposed exactly two whole-string functions at research time:

```rust
pub fn format_source(input: &str, width: usize) -> Result<String, SemaError>
pub fn format_source_opts(input: &str, width: usize, indent: usize, align: bool) -> Result<String, SemaError>
```

There is no range/offset parameter — but `format_source_opts` formats *whatever string it is handed*: `tokenize(rest)` → `build_nodes` → `Formatter::format_top_level(&nodes)`, with zero document-context assumptions. So **passing a single extracted top-level form already works today** and yields that form formatted at column 0. That is the lever that makes rangeFormatting feasible without touching the crate.

Constraints to respect:

- **Strict parsing, no recovery.** `build_group` returns `Err("unclosed delimiter")` on unbalanced parens; a stray closer errors `"unexpected closing delimiter"`. It can only format a fragment that is itself balanced/complete. (The existing `handle_formatting` already relies on this — returns `None` on `Err(_)`, `crates/sema-lsp/src/lib.rs:2997–3001`.)
- **No leading-indent parameter.** `format_top_level` emits every top-level form at column 0; child indentation grows from 0. A formatted form always comes back left-flushed, so the only *safe* unit is a **whole top-level form** (which lives at column 0 anyway), never an arbitrary inner sub-expression.
- **Trailing-newline normalization.** `format_source_opts` always strips trailing whitespace per line, collapses 3+ blank lines to 1, and normalizes to exactly one trailing `\n`. The trailing `\n` is the main per-form-edit gotcha.

#### Existing infrastructure (already in place)

- `handle_formatting(&self, uri, options) -> Option<Vec<TextEdit>>` (`lib.rs:2988`) — whole-doc, maps editor `tab_size` → formatter `indent`, width hardcoded 80, align off.
- `top_level_ranges(exprs, span_map, lines) -> Vec<(usize, Range)>` (`helpers.rs:240`) — index + LSP `Range` per top-level **list** form (bare atoms skipped: `expr_range` uses `as_list_rc`).
- `span_to_range` (`helpers.rs:147`) — Sema 1-indexed char spans → 0-indexed UTF-16 LSP ranges, astral-char correct + tested.
- Cached parses per URI (`CachedParse { ast, span_map, symbol_spans, scope_tree, source }`), plus `position_in_range`, `span_contains`, `collect_selection_list_ranges`.
- mpsc request enum + `formatting` async dispatcher (`lib.rs:4109`) and worker-loop branch (`lib.rs:4462`) — a new variant is mechanical.
- **IntelliJ already wired:** `SemaFormattingFeature : LSPFormattingFeature` (gated on `SemaSettings.formattingEnabled`), set via `SemaLanguageServerFactory.createClientFeatures()`. LSP4IJ's `LSPFormattingAndRangeBothService` auto-activates `textDocument/rangeFormatting` when the server advertises `documentRangeFormattingProvider` — **no IntelliJ code change** beyond optionally honoring the existing toggle.

#### Recommended approach (range formatting)

1. Advertise `document_range_formatting_provider: Some(OneOf::Left(true))` in `ServerCapabilities` (`lib.rs ~3807`, next to `document_formatting_provider`).
2. Add `RangeFormatting { uri, range, options, reply }` to `LspRequest`, the async handler, and a worker-loop branch (mirror `Formatting` exactly).
3. New `handle_range_formatting`:
   - Look up `CachedParse` (bail `None` if absent).
   - Use `top_level_ranges` to find **every top-level form intersecting the requested range** (start ≤ req.end and end ≥ req.start); snap/expand to whole forms.
   - For each form, slice the **original source** for that form's span, run `format_source_opts(slice, 80, indent, false)`, emit **one `TextEdit`** per form with the form's exact range and the formatted slice **with the trailing `\n` stripped**.
   - On `Err` for a form, skip just that form (or return `None`) — never corrupt the buffer.
   - Drop no-op edits (formatted == original) for idempotency.

**Cheaper fallback:** when the request range covers the whole document (common from IntelliJ "Reformat Code" / LSP4IJ), just delegate to `handle_formatting`. That alone is a meaningful win for near-zero code (**S**).

#### Risks

- **Trailing-newline mismatch (highest-value gotcha):** per-form edit ranges end at the form's last `)`; you must strip the appended `\n` or you inject blank lines. Cover with a test.
- **No base-indent:** never range-format an inner sub-expression — restrict to top-level forms. (A future "format nested form" would need a `base_indent` param in sema-fmt — out of scope.)
- **Strict parsing:** broken forms no-op (consistent with whole-doc behavior).
- **Inter-form blank-line spacing** isn't fixed by range formatting (slices are at form spans) — document as expected.
- **Bare-atom top-level forms** are skipped by `top_level_ranges` — left untouched, harmless.
- UTF-16 columns handled by `span_to_range`.

#### On-type formatting assessment

**Do NOT implement server-side `textDocument/onTypeFormatting`.** A per-keystroke handler reformatting on `)` fights the strict (recovery-free) formatter — during typing the document is usually unbalanced, so it would no-op constantly. High effort, low payoff.

**Use LSP4IJ client-side on-type formatting instead.** `SemaFormattingFeature` extends `LSPFormattingFeature`, which exposes `isFormatOnCloseBrace(file)`, `getFormatOnCloseBraceCharacters(file)`, `getFormatOnCloseBraceScope(file)` (`CODE_BLOCK`/`FILE`), `isOnTypeFormattingEnabled`, `isExistingFormatterOverrideable`. For Lisp the only sensible trigger is `)` (plus likely `]`, `}` for vectors/maps). Scope `CODE_BLOCK` reformats the just-closed form, and **client-side close-brace formatting routes through the range formatting path**, so it gets the rangeFormatting work for free. Net: a few-line Kotlin override (return `true` from `isFormatOnCloseBrace`, `")" "]" "}"` from `getFormatOnCloseBraceCharacters`, scope `CODE_BLOCK`), ideally behind a new `SemaSettings` toggle next to `formattingEnabled`.

#### Effort & sequencing

- **Range formatting (server): S–M** — mostly plumbing (request variant + async handler + worker branch, copy-shaped from `Formatting`) + one `handle_range_formatting` (~40–80 lines) reusing `top_level_ranges`/`span_to_range` + one capability flag. Add unit tests mirroring `formatting_*` (formatted/unformatted/unparseable/unknown-uri + the trailing-newline boundary case). Full-doc-range delegation shortcut is **S** alone.
- **On-type (IntelliJ client-side): S** — a handful of Kotlin overrides + optional settings checkbox. No Rust changes, no new server capability. Depends on range formatting existing.
- **Sequence:** (1) add server `rangeFormatting` (start with full-doc-range delegation, then per-form scoping); (2) flip on LSP4IJ client-side close-brace formatting. Keep width hardcoded at 80 to match `handle_formatting` and the `sema fmt` CLI.

**Key refs:** `crates/sema-fmt/src/lib.rs`, `crates/sema-fmt/src/formatter.rs:1641–1706`; `crates/sema-lsp/src/lib.rs:2988–3026` (handler), `:3807` (capabilities), `:4109`/`:4462` (dispatch); `crates/sema-lsp/src/helpers.rs:147` (`span_to_range`), `:240` (`top_level_ranges`), `:49–64` (`expr_range`/`expr_span`); `editors/intellij/.../lsp/SemaFormattingFeature.kt`, `SemaLanguageServerFactory.kt:18–22`; `editors/intellij/.../config/SemaSettings.kt:34–44`.

### 5.2 User-Defined Docstrings

**Verdict: docstrings do NOT exist as a language feature today.** A docstring-style string can be *written* (and is, widely, in real `.sema` code), but it parses as an ordinary body expression, is evaluated, and is discarded — never captured, stored, or queryable. This is a **net-new feature**, already designed (in `docs/design/living-code.md` "Layer 0") but unimplemented.

#### Current state

- **Parser** (`crates/sema-reader`): no docstring slot. Comments (`;`, `;;`) are `Token::Comment` and dropped during parse (`reader.rs:36,47,57`); string literals are plain `Value` strings.
- **Special forms** (`crates/sema-eval/src/special_forms.rs`): `eval_define` (358) sets `body = args[1..]`; `eval_defun`/`defn` (433, alias at 242) reads `args[0]`=name, `args[1]`=params (**must be a list**), `body = args[2..]`; `eval_defmacro` (824) `body = args[2..]`. None extract a docstring.
- **Value structs** (`crates/sema-core/src/value.rs:140,150`): `Lambda` and `Macro` have **no `doc` field** (only `params`, `rest_param`, `body`, `env`, `name`).
- **Consequence:** a leading string in the body becomes the first body expression, evaluated and discarded (it's not in tail position). A pure no-op constant.
- **Only structured "doc" that exists:** `ToolDefinition.description` (`value.rs:308`, set by `deftool`'s 2nd positional arg at `special_forms.rs:1105`) and `Agent.system` — LLM machinery, not general docs. The formatter comment at `crates/sema-fmt/src/formatter.rs:246` ("docstring goes on its own line") refers only to laying out the `deftool`/`defagent` description string.
- **No runtime mechanism:** no `doc`/`help`/`describe`/`meta` builtin in `crates/sema-stdlib`. The REPL `,doc NAME` (`crates/sema/src/repl/commands.rs:141`) prints only the param list for a user `Lambda` (`commands.rs:167–181`) and pulls builtin/special-form text from `sema_lsp::builtin_docs::build_builtin_docs()`.

#### Strong informal convention already in the wild

Real `.sema` code uses the Clojure/Lisp docstring position — a string as the first body form, **after** the param list: `(defn name (params) "docstring" body...)`. Seen in `examples/eliza.sema` (9 functions), `examples/pi-sema/util.sema`/`display.sema`/`commands.sema` (~30+ functions), `examples/eliza-web.sema`. These parse cleanly today and are silently discarded.

**Important position discrepancy:** `docs/design/living-code.md` proposes docstring *before* the param list. That would **fail** today (`args[1]` would be a string, not a list, violating `defn`'s "params must be a list" check) and would orphan all existing examples. **Recommend the after-params position** (what the code already uses, the Clojure standard).

#### LSP angle (the subject of the follow-up)

`handle_completion_resolve` (`lib.rs:2035`) renders user symbols via `user_definition_signature` → `extract_params_from_ast` (`helpers.rs:332`), which extracts **only the param list** and never looks at the body — so no docstring is or can be surfaced. `extract_params_from_doc` (`lib.rs:3533`) parses params out of *builtin markdown*, not user source.

Because the docstring string already exists in the parsed AST as `body[0]`, the LSP can read it directly with **no core change**.

#### Concrete work

**A. Language core (full feature):**
1. Pick the convention — docstring *after* the param list.
2. `sema-core/src/value.rs` — add `doc: Option<String>` to `Lambda` (optionally `Macro`).
3. `sema-eval/src/special_forms.rs` — in `eval_define`/`eval_defun`: when body has >1 form and `body[0]` is a string literal, lift it into `Lambda.doc` and drop from body. **Guard:** if the string is the *only* body form, keep it as the return value (don't treat as doc).
4. `crates/sema-vm/src/lower.rs` — mirror the same lift/strip so both backends agree (dual-eval).
5. Dual-eval tests in `crates/sema/tests/dual_eval_test.rs`.

**B. LSP extraction (the follow-up's goal):**
6. `crates/sema-lsp/src/helpers.rs` — add `extract_docstring_from_ast(ast, name)` reading `body[0]` of the matching `defun`/`defn`/`define`.
7. `crates/sema-lsp/src/lib.rs` — in `handle_completion_resolve` (and `handle_hover`) append the docstring under the signature.

**C. Runtime introspection (optional, completes it):** `(doc name)` / `(meta name)` builtins (new `sema-stdlib/introspect.rs`); upgrade REPL `,doc` to print user docstrings.

#### Effort

- **LSP-only slice (S):** `extract_docstring_from_ast` reads `body[0]` from the already-parsed AST; ~40–80 lines across `helpers.rs` + `lib.rs`. No core/eval changes. Caveat: surfaces a string the runtime still evaluates-and-discards (cosmetic, harmless).
- **Full language feature (M):** matches the living-code "Medium" estimate; spans `sema-core`, `sema-eval`, `sema-vm`, `sema-stdlib`, `sema-lsp` + dual-eval tests. Main traps: the dual-backend strip and the single-body-form edge case.

**Recommendation:** ship the **S** LSP slice now to satisfy the completion-resolve follow-up (the docstring text already exists in the AST for eliza/pi-sema-style code), and track the full **M** feature against `docs/design/living-code.md` Layer 0.

**Key refs:** `crates/sema-eval/src/special_forms.rs:358,433,824`; `crates/sema-core/src/value.rs:140,150,306`; `crates/sema-lsp/src/lib.rs:2035,2060,3492`; `crates/sema-lsp/src/helpers.rs:332,370`; `crates/sema/src/repl/commands.rs:141`; `docs/design/living-code.md:30–95`; `examples/eliza.sema`, `examples/pi-sema/util.sema`.

### 5.3 DAP Server Capabilities

**Verdict: 6 high-value additions are feasible against the existing VM debug hooks (most M, some S); 4 are not worth doing for IntelliJ.**

#### Current inventory

**Advertised `Capabilities`** (`crates/sema-dap/src/server.rs:122–132`): only `supportsConfigurationDoneRequest: true`; the other 7 explicitly false (`supportsFunctionBreakpoints`, `supportsConditionalBreakpoints`, `supportsStepBack`, `supportsSetVariable`, `supportsRestartFrame`, `supportsModulesRequest`, `supportsExceptionInfoRequest`). Everything else defaults false/unset (no `exceptionBreakpointFilters`, `supportsEvaluateForHovers`, `supportsHitConditionalBreakpoints`, `supportsLogPoints`, `supportsTerminateRequest`, etc.).

**14 request handlers** (`server.rs:121–425`): `initialize`, `launch`, `setBreakpoints` (line-only; ignores `condition`/`hitCondition`/`logMessage`), `configurationDone`, `threads` (hardcoded single thread id 1), `stackTrace`, `scopes` (Locals + Closure/upvalues), `variables` (flat; all `variablesReference: 0`), `continue`, `next`, `stepIn`, `stepOut`, `pause`, `disconnect`. Anything else → `unsupported command: {other}` (`server.rs:415–424`).

**4 events** (`server.rs:75–104,135`): `initialized`, `stopped` (breakpoint/step/pause/entry), `terminated`, `output`. No `exited`, `thread`, `breakpoint`, `continued`, `loadedSource`, `module`, `process`. Note: `StopReason::Entry` is never actually produced — `stopOnEntry` is implemented as `StepMode::StepInto` (`server.rs:526–528`), so the first stop reports as `"step"`.

**NOT implemented:** `attach`, `setExceptionBreakpoints`, `setFunctionBreakpoints`, `setInstructionBreakpoints`, `setDataBreakpoints`/`dataBreakpointInfo`, `evaluate`, `setVariable`, `setExpression`, `restart`, `restartFrame`, `terminate`, `source`, `exceptionInfo`, `modules`, `loadedSources`, `completions`, `gotoTargets`, `stepInTargets`.

#### Client constraints (LSP4IJ + IntelliJ)

The IntelliJ client (`SemaDebugAdapterDescriptorFactory.kt`) is **LAUNCH-only**: `canRun` true only for `DebugMode.LAUNCH` (42–43), `getDebugMode()` returns `DebugMode.LAUNCH` (101). LSP4IJ's DAP client forwards `setBreakpoints` (incl. `condition`/`hitCondition`/`logMessage`), `setExceptionBreakpoints`, and `setInstructionBreakpoints`; it does **not** forward `setFunctionBreakpoints` or `setDataBreakpoints`.

#### VM debug substrate (what's available)

`crates/sema-vm/src/debug.rs` + `vm.rs`: per-instruction `should_stop(file, line, frame_depth)` (`vm.rs:755`, `debug.rs:185`); breakpoint map keyed by `(PathBuf, line)` (`debug.rs:122`); full frame access for stack/scopes/variables (`vm.rs:2245–2335`); frame-walking exception unwinder `handle_exception` returning `Propagate` for uncaught errors (`vm.rs:2179–2237`); bytecode compiler reachable from the running VM (`compile_program_with_spans`, `vm.rs:2553`); `error_to_value` (`vm.rs:2361`). **No** runtime "evaluate string in frame" path; `set_breakpoints` takes only `&[u32]` lines (`debug.rs:214`); locals live in a flat stack indexed by slot (`vm.rs:2274–2283`), not a name→value `Env`.

#### Prioritized additions

**P1 — Conditional breakpoints (`supportsConditionalBreakpoints` + `condition`) — M.** Client already sends `condition`. Requires: (a) extend the breakpoint map value from a bare id to `(id, Option<String>)` (`debug.rs:122`, `set_breakpoints` sig `debug.rs:214`); (b) at the stop point (`vm.rs:755`) compile+eval the condition against the current frame's locals and stop only if truthy. The eval-in-frame machinery (P3) is the hard part — without it, conditions can't reference locals. Scoped to global-only conditions first, it drops to **S/M**.

**P2 — Exception breakpoints (`exceptionBreakpointFilters` + `setExceptionBreakpoints` + `supportsExceptionInfoRequest`) — M.** Single highest-leverage debugging feature for a dynamic language. The unwinder already detects uncaught exceptions: `handle_exception` returns `ExceptionAction::Propagate(err)` (`vm.rs:2236`). Add a "break on uncaught" (optionally "break on caught/thrown") flag to `DebugState`; when set and an exception is about to propagate, emit `Stopped { reason: Exception }` before returning `Err`. Add filters `["uncaught", "raised"]` to the initialize body, a `setExceptionBreakpoints` handler, and `StopReason::Exception`. `exceptionInfo` then surfaces the error map via `error_to_value`.

**P3 — `evaluate` request (REPL / watch / hover) + `supportsEvaluateForHovers` — M/L.** No current path to eval an arbitrary string in a stopped frame. Read `expression` + `frameId` + `context`, compile via `compile_program_with_spans`, run in an env seeded from the frame's locals/upvalues. Complication: locals are flat slots, not a name→value `Env`, so synthesize a child `Env` from `local_names`/upvalues. Watch/hover (read-only) is achievable; full side-effecting REPL eval mid-execution is riskier. Pairs with P1. `supportsEvaluateForHovers: true` is a one-line add once `evaluate` exists.

**P4 — `setVariable` (`supportsSetVariable`) — S/M.** Mechanically easy: locals at `frame.base + slot` (`vm.rs:2275`), upvalues reachable (`vm.rs:2287–2311`). Main work is plumbing a `SetVariable` `DebugCommand` and parsing the input string into a `Value` (reuse the reader). Modest value, cheap.

**P5 — `terminate` request + `exited` event + `supportsTerminateRequest` — S.** Currently only `disconnect` stops the session (`server.rs:407`). Add a graceful `terminate` and emit `exited` (with exit code) on program completion — small, improves IDE lifecycle correctness.

**P6 — Hit-count breakpoints / logpoints (`hitCondition` / `logMessage`) — S each, ride on P1.** Once the breakpoint value carries metadata, hit counters and logpoints (emit `output` instead of stopping) are small additions. LSP4IJ already sends both fields.

#### Not worth doing for IntelliJ

- **`attach` — L, and blocked client-side** (`canRun`/`getDebugMode` LAUNCH-only). The VM is in-process per-launch with no remote/IPC listener; "attach" has no target. Skip unless a long-running embedded VM (e.g. notebook kernel) becomes a debug target.
- **`setFunctionBreakpoints` — M server-side but not forwarded by LSP4IJ** → no IntelliJ payoff.
- **`setDataBreakpoints` / watchpoints — L, no NaN-boxed-value write hooks; low value for Lisp.**
- **`setInstructionBreakpoints` — L, niche**; client supports it but needs disasm/instruction-reference UI + `supportsDisassembleRequest`.

**Key refs:** `crates/sema-dap/src/server.rs:121–425` (handlers + capabilities); `crates/sema-vm/src/debug.rs` (DebugState/commands/breakpoint map); `crates/sema-vm/src/vm.rs:755` (stop check), `:2245–2335` (inspection), `:2179–2237` (exception unwind), `:2361` (`error_to_value`); `editors/intellij/.../dap/SemaDebugAdapterDescriptorFactory.kt:42–43,101` (LAUNCH-only gate).

---

## 6. Suggested Priority Order (Across Everything)

Ordered by value-per-effort, with cross-feature dependencies respected.

1. **[S] Parser fix: trailing-text headings** (recovers 12 `cadr`/`caddr` functions) + **[S] strip `:::` containers** (regex/strings/maps/records hover quality). High visibility, tiny code. (§4 items 1–2)
2. **[S] Fix `with-budget` → `llm/with-budget` key** + **[S] add the 7 missing special-form docs** + **[S] decide/remove `for/*` dead entries**. Cheap correctness wins. (§4 items 8–10)
3. **[M] Hover/resolve precedence reorder** so user/imported defs beat `builtin_docs`. Fixes a real correctness bug (redefinitions). (§4 item 11)
4. **[S→M] Range formatting (server)** — start with full-doc-range delegation (**S**), then per-form scoping (**M**). Unlocks client-side on-type. (§5.1)
5. **[S] Client-side on-type formatting** (IntelliJ close-brace) once range formatting lands. (§5.1)
6. **[M] DAP exception breakpoints + exceptionInfo** (P2) — highest debugging value, uncaught path already exists. (§5.3)
7. **[S] LSP docstring slice** (`extract_docstring_from_ast` from existing AST `body[0]`) — satisfies the completion-resolve follow-up with no core change. (§5.2)
8. **[M] DAP conditional breakpoints** (P1) + **[S] hit-count/logpoints** (P6, ride on P1). (§5.3)
9. **[S] DAP `terminate` + `exited` event** (P5) + **[S/M] `setVariable`** (P4). Lifecycle + cheap inspection. (§5.3)
10. **[M] Markdown normalization** (http-json bare fences, regex `**Signature:**`) + **[M] duplicate-key handling** + audit/coverage tests. Source hygiene that prevents regressions. (§4 items 3–7, 12–13)
11. **[M/L] DAP `evaluate` (watch/hover/REPL)** (P3) — needs frame→Env synthesis; do after P1/P2 since it shares the eval-in-frame work. (§5.3)
12. **[M] Full docstring language feature** (core `doc` field + eval/VM strip + dual-eval tests + runtime `doc`/`meta`) — track against `docs/design/living-code.md` Layer 0. (§5.2)
13. **[S] Tighten the clippy gate** (`--all-targets`, include the 4 omitted crates, add `cfg_attr(test, allow(approx_constant))`). Process hygiene; do whenever convenient. (§1.5)

**Explicitly skip:** DAP `attach`, `setFunctionBreakpoints`, data/instruction breakpoints (all blocked or low-value for IntelliJ); server-side on-type formatting (fights the strict formatter). Kotlin/JS formatter adoption is a config decision, not a code task.
