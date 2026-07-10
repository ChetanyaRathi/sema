# Language friction found while hardening sema-coder (2026-07-09)

Raw notes from a correctness/async/elegance pass over `examples/sema-coder/`,
for triage into issues. Each item is something the language/stdlib made harder
than it should be — including two gaps that let real bugs ship silently in the
flagship example.

## Status

All items below were verified against 1.30.0 and filed as GitHub issues on
`sema-lisp/sema` (2026-07-10): **#82–#94**. Two originally-noted items were
disproven on verification and NOT filed (item 3 tool accessors, item 6 agent
constructor — both already supported); item 4 was narrowed to PARTIAL. One
incidental gap surfaced during verification and was filed as **#94** (prelude
macro names can't be `(define (name …) …)` heads).

## Blocker (filed separately)

0. **Stale global reads in recursive functions from `load`ed units** — [#82].
   The TUI's quit flag (`set!` from a command handler, read by the key loop) is
   never observed, so the TUI can't exit; 9-line repro and characterization in
   `docs/bugs/load-unit-stale-global-read-in-recursive-fns.md`. sema-coder now
   reads the flag through an accessor as a workaround.

## Stdlib gaps that caused shipped bugs

1. **`string/index-of` has no start-offset arg.** Strict 2-arity. sema-coder's
   `count-occurrences` called `(string/index-of s needle pos)` from day one, so
   the **edit-file tool always failed** with an arity error — swallowed by the
   tool-level `try` and returned to the model as an "Error editing…" string it
   silently routed around. Suggest: optional third `start` arg (nearly every
   string API has one), and/or a `string/count-occurrences` builtin. (Workaround
   used: `(- (length (string/split s needle)) 1)`.)
2. **`take`/`drop` argument order is a silent trap.** Count-first
   (`(take 2 xs)`), but two call sites in tools.sema used list-first — the
   read-file (>2000 lines) and bash (>500 lines) truncation paths raised type
   errors instead of truncating. Nothing flags this before runtime. Suggest:
   accept both orders (dispatch on types, Clojure-style), or a checker/LSP lint
   for `(take <list-literal|known-list> <int>)`.

## Agent/tooling surface

3. **~~Tool values are opaque.~~ RESOLVED — not a gap.** Accessors DO exist:
   `tool?`, `tool/name`, `tool/description`, `tool/parameters` (verified live).
   sema-coder's parallel `tool-names` list can be dropped in favor of
   `(map tool/name (all-tools))`. Do NOT file. (`tool/schema` as an alias of
   `tool/parameters` would be a minor nicety, not worth an issue.)
4. **`deftool` ignores `:default` (requiredness works).** PARTIAL, filed as
   [#85]. Verified: `:optional #t` already works and drives the provider's
   JSON-Schema `required`; what's missing is `:default` (stored but never
   injected) and any documentation of `:optional`. Omitted args still bind to
   `nil` (so nil-guards are still needed until `:default` lands).
5. **`agent/run`'s result map has no `:usage`.** A multi-round turn makes N
   provider calls; `llm/last-usage` reports only the final round — sema-coder's
   token HUD silently undercounted until switched to `llm/session-usage`.
   Suggest: fold the turn's cumulative usage into the result map
   (`{:response :messages :usage}`).
6. **~~No non-defining agent constructor.~~ RESOLVED — not a gap.** `(agent
   {...})` IS a first-class constructor (documented: "the plain constructor;
   the named form is `defagent`"). Verified live. sema-coder's `create-agent`
   can drop the `defagent`-in-a-function pattern for `(agent {...})`. Not filed.
7. **A cancelled streaming turn loses the transcript delta.** After
   `async/cancel` on an `agent/run` task there is no way to recover the
   partial `:messages` (streamed text + completed tool rounds), so an
   interrupted turn vanishes from history on the next turn.

## Async / TUI

8. **`io/read-key-timeout` and `event/select` block the cooperative
   scheduler.** Unlike `file/*`, `http/*`, `shell`, and the LLM path, they have
   no `in_async_context()` offload — so a "wait for key OR agent progress" loop
   must busy-pump (`read-key-timeout 0` + `async/sleep 16`), costing latency
   and wakeups. Suggest: make `event/select` (at least the `:key` source)
   offload/yield in async context — it's billed as "the unified wait for a TUI
   loop" and would make the pump pattern unnecessary.

## Shell

9. **No shell-quoting helper.** `shell`'s single-string form goes through
   `sh -c`, and the `cd <dir> && …` workspace-pinning idiom breaks on paths
   with spaces/quotes unless you hand-roll POSIX quoting (sema-coder now
   carries its own `sh-quote`). Suggest: `shell/quote` builtin.
10. **`shell` has no options map (`:cwd`, `:env`).** `proc/spawn` has them but
    is a different (streaming, handle-based) API; for a one-shot command in a
    directory you're forced into the `cd &&` idiom from (9).

## Smaller ergonomics

11. **No `map-indexed`/`enumerate` builtin.** Hand-rolled twice in tui.sema
    (`enumerate`, `enumerate-map`).
12. **Sequence functions don't accept mutable arrays.** `map`/`for-each`/
    `filter` need `(mutable-array/->vector a)` first — an O(n) copy per frame
    in a render loop, exactly where mutable arrays are pitched.
13. **No width-aware truncation.** `string/width`/`string/word-wrap`/
    `string/pad-*` are display-width-aware, but there's no
    `string/truncate-width`, so TUI cells that clamp long text (palette
    descriptions, tool args) still count codepoints and misalign on CJK/emoji.
    (sema-coder hand-rolls `clip-width` in tui.sema.)
14. **No markdown → terminal renderer.** `markdown/to-html` and the structured
    `markdown/headings`/`markdown/frontmatter` exist, but there is no
    `markdown/to-ansi` / `term/markdown` that renders CommonMark to styled
    terminal text (headings, bold/italic, inline code, fenced code blocks,
    bullet/numbered lists). Every terminal LLM app needs this — agent replies
    ARE markdown — so each one re-implements a parser. Suggest a
    `markdown/to-ansi` builtin (width-aware, theme-able) reusing the
    `pulldown-cmark` parser already vendored for `markdown/to-html`.
