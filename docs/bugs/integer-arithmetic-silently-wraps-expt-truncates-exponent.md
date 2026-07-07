# Integer arithmetic silently wraps at i64 bounds — and expt truncates its exponent to u32

**Status:** FIXED (2026-07-07) — int `+`/`-`/`*`/`expt` now raise a catchable "integer overflow" error (checked ops) instead of wrapping, in the stdlib, VM (`vm_add`/`vm_sub`/`vm_mul` + `MUL_INT`), and constant folder; `expt` validates its exponent (u32 + special 0/1/-1). Consistent with `abs`. Regression: `*_overflow_errors`/`expt_*` in `eval_test.rs`.
**Verified against:** fresh debug build at `acd44732` (`sema 1.28.1`)
**Area:** `sema-stdlib` numeric ops (`crates/sema-stdlib/src/arithmetic.rs`, `crates/sema-stdlib/src/math.rs`)

## Repro

```bash
sema -e '(println (+ 9223372036854775807 1))'
# -9223372036854775808            (i64::MAX + 1 wraps to i64::MIN)

sema -e '(println (* 9223372036854775807 9223372036854775807))'
# 1                               (i64::MAX² wraps all the way to 1)

sema -e '(println (expt 2 64))'
# 0                               (2^64 wraps to 0)

sema -e '(println (expt 2 4294967296))'
# 1                               (exponent 2^32 truncated to 0 → 2^0)
```

Expected: either arbitrary-precision promotion or a loud overflow error —
anything but silently returning a wrong number. The last case is a second,
independent bug: the exponent itself is truncated with `as u32` *before* the
power is computed, so `(expt 2 4294967296)` doesn't even overflow — it
computes `2^0`.

## Cause

- `crates/sema-stdlib/src/arithmetic.rs` uses `wrapping_add` (line 37),
  `wrapping_neg` (62), `wrapping_sub` (82), `wrapping_mul` (119) on the
  int-int fast paths — deliberate no-panic choices, but the wrap is silent.
- `crates/sema-stdlib/src/math.rs:9` (`pow_impl`):
  `base.wrapping_pow(exp as u32)` — the `as u32` cast truncates any exponent
  ≥ 2^32 modulo 2^32, and `wrapping_pow` wraps the result.

There is no bigint type to promote to: `TAG_INT_BIG`
(`crates/sema-core/src/value.rs:524`) is only a heap-boxed `i64` for values
outside the 45-bit NaN-box payload, and `string->number` already punts
overflowing literals to `f64` (`(string->number "9223372036854775808")` →
`9223372036854775808.0`).

## Notes

- Fix directions: switch the int fast paths to `checked_*` and, on `None`,
  either raise `SemaError::eval("integer overflow …")` or promote (to `f64`
  as `string->number` does, or to a real bigint if one is ever added). For
  `expt`, validate the exponent range explicitly (`i64` → error when the
  checked power overflows) instead of `as u32`.
- Severity: **medium** — silent wrong answers in ordinary arithmetic
  (checksums, ids, money-in-cents at scale, `(expt 2 n)` bit tricks), but the
  bounds are astronomical for typical scripts. The `expt` exponent
  truncation is the sharpest edge since it's wrong long before i64 overflow
  is plausible.
