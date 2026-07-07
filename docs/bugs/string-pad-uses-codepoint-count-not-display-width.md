# string/pad-left and string/pad-right pad by codepoint count — CJK/emoji columns misalign despite string/width existing

**Status:** FIXED (2026-07-07) — `string/pad-left` and `string/pad-right` measure with `display_width` (shared `pad_to_width` helper, floors on wide pad chars). Regression: `pad_right_uses_display_width` in `eval_test.rs`.
**Verified against:** fresh debug build at `acd44732` (`sema 1.28.1`)
**Area:** `sema-stdlib` string padding (`crates/sema-stdlib/src/string.rs`)

## Repro

```bash
sema -e '(println (str "[" (string/pad-right "日本語" 6) "]")) (println (str "[" (string/pad-right "abc" 6) "]"))'
# [日本語   ]
# [abc   ]
```

The two "6-wide" cells render at different terminal widths: `日本語` is 3
codepoints but **6 display columns** (`(string/width "日本語")` → `6`,
`(string-length "日本語")` → `3`), so pad-right adds 3 spaces and produces a
9-column cell next to the 6-column ASCII one. Any table/column layout built
on the pad functions misaligns as soon as a cell contains CJK, emoji, or
other wide/zero-width characters.

Expected: padding to a target *width* should use display width — the stdlib
already ships the correct measure (`string/width`,
`crates/sema-stdlib/src/string.rs:1325`, with the width logic shared with
`string/word-wrap` per the comment at `string.rs:13`); the pad functions
just don't use it.

## Cause

`crates/sema-stdlib/src/string.rs` — both pad functions measure with
`s.chars().count()`:

- `string/pad-left` (registered at `string.rs:481`, `let char_len =
  s.chars().count();` at `string.rs:496`)
- `string/pad-right` (registered at `string.rs:504`, same pattern at
  `string.rs:519`)

So the target is interpreted as a codepoint count, not columns. Anything
that pads on top of `string-length`-style measures downstream (report
formatting, REPL/table helpers, user code) inherits the misalignment.
(There is no `fmt/table` builtin today — the exposure is the pad fns and
whatever users build on them.)

## Notes

- Fix direction: measure with the shared display-width helper used by
  `string/width` instead of `chars().count()` in both pad fns. Decide the
  edge semantics while at it: when the string is *wider* than the target the
  current code returns it unchanged (fine), and an odd column deficit with a
  wide pad char can't be filled exactly (pick floor). If codepoint-padding
  is considered a feature, keep it and add width-aware variants — but the
  pair `string/width` + codepoint-padding as shipped is a trap.
- Severity: **low** — cosmetic misalignment only, no data corruption; but
  it's a silent i18n bug in every column layout and the fix is contained.
