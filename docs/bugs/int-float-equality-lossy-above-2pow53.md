# Int↔float `=` is lossy above 2^53 — distinct numbers compare equal

**Status:** FIXED (2026-07-07) — exact `cmp_int_float` in `sema-core::num`, shared by the VM (`vm_eq`/`vm_lt`) and stdlib `=`/`<`/`>`. Regression: `int_float_*` in `eval_test.rs`, unit tests in `num.rs`.
**Verified against:** fresh debug build at `acd44732` (`sema 1.28.1`)
**Area:** `sema-stdlib` numeric comparison (`crates/sema-stdlib/src/comparison.rs`)

## Repro

```bash
sema -e '(println (= 9007199254740993 9007199254740992.0))'
# #t          ← 2^53+1 vs 2^53 — different numbers
```

Expected `#f`: `9007199254740993` (2^53 + 1) and `9007199254740992.0` (2^53)
are mathematically different. The int is cast to `f64` for the comparison,
and 2^53+1 is not representable in `f64` — it rounds to 2^53, so the two
"become" equal.

## Cause

`crates/sema-stdlib/src/comparison.rs:41` — the mixed int/float arm of `=`:

```rust
(ValueViewRef::Int(a), ValueViewRef::Float(b))
| (ValueViewRef::Float(b), ValueViewRef::Int(a)) => {
    if (a as f64) != b {
```

`a as f64` is exact only for `|a| ≤ 2^53`; above that it rounds, collapsing
up to 2^k−1 adjacent integers onto each representable float. The same cast
pattern feeds the ordering comparisons via `as f64` at
`comparison.rs:9`, so `<`/`>`/`<=`/`>=` inherit the same fuzziness at the
same magnitudes.

## Notes

- Fix direction: compare exactly instead of casting — check the float is
  integral and in i64 range, then compare as integers (the
  `float-is-integral + i128` approach handles the i64::MAX edge where
  `i64::MAX as f64` rounds *up* out of range); or, more drastically, make
  mixed-representation `=` an error and require explicit conversion. The
  exact-comparison route matches Scheme's numeric-tower expectation for `=`.
- Severity: **low/medium** — silent wrong booleans, but only for mixed
  int/float comparisons beyond 2^53 (ids, timestamps in nanoseconds, hashes
  stored as floats after `json` round-trips are the realistic triggers —
  note `string->number` and JSON decoding already promote big integers to
  `f64`, which is exactly how such mixed comparisons arise).
