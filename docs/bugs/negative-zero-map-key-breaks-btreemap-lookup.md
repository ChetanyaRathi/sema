# -0.0 as a map key breaks lookup — Ord distinguishes signed zeros while `=` and Hash don't

**Status:** FIXED (2026-07-07) — the `Ord` float arm in `value.rs` normalizes signed zeros before `total_cmp`, matching `Hash` and `=`. Regression: `neg_zero_map_key_retrievable` in `eval_test.rs`.
**Verified against:** fresh debug build at `acd44732` (`sema 1.28.1`)
**Area:** `sema-core` `Value` ordering vs equality (`crates/sema-core/src/value.rs`), surfaces through `BTreeMap`-backed maps

## Repro

```bash
sema -e '(define nz (- 0.0)) (define m (assoc {} nz "x")) (println (get m nz)) (println (get m 0.0))'
# x
# nil          ← a key `=`-equal to the stored key is not found
```

And the mirror direction — a map keyed by `+0.0` can't be probed with a
computed `-0.0`:

```bash
sema -e '(define m (assoc {} 0.0 "pos")) (println (get m (- 0.0)))'
# nil
```

Expected: `(= (- 0.0) 0.0)` is `#t` (verified), so the two must behave as
the same map key — both `get`s should return the stored value.

Note the repro needs a *computed* `-0.0` (`(- 0.0)`, or a `-0.0` literal in a
non-constant-folded position such as a lambda body): a top-level `-0.0`
literal reaches the map as `+0.0` (it prints as `0.0` and hits the `+0.0`
entry), which masks the bug in casual REPL testing.

## Cause

The three key-identity relations on `Value` disagree about signed zero:

- **Ord** (`crates/sema-core/src/value.rs:2086`):
  `(Float(a), Float(b)) => a.total_cmp(&b)` — IEEE total order, where
  `-0.0 < +0.0` (needed so NaN sorts and maps can hold float keys at all).
- **Hash** (`crates/sema-core/src/value.rs:1986`): normalizes both zeros to
  the same bits (`let bits = if f == 0.0 { 0u64 } else { f.to_bits() }`).
- **`=` / PartialEq**: IEEE equality, `-0.0 == +0.0`.

User maps are `BTreeMap`s, so lookup goes through Ord — `-0.0` and `+0.0`
are distinct keys there while every other equality surface says they're the
same. (Hash-consistency is fine; the divergence is Ord-only.)

Mirror case, arguably acceptable: a NaN key **is** retrievable
(`total_cmp(NaN, NaN) == Equal`) even though `(= nan nan)` is `#f` — the
opposite divergence. Worth deciding deliberately if signed zero is fixed.

## Notes

- Fix direction: normalize `-0.0` to `+0.0` in the Ord float arm
  (`total_cmp` on the normalized values keeps NaN handling intact), or
  normalize at the map-key boundary (`assoc`/`get`/`contains?`/`dissoc`).
  The Ord fix is one line and automatically covers `sort`
  (`(sort (list 0.0 (- 0.0)))` currently orders them as distinct:
  `(-0.0 0.0)`).
- Severity: **low/medium** — needs a float key and a computed negative zero
  (e.g. rounding results crossing zero), but when it hits, data silently
  vanishes from a map with no error.
- Session repro: `hunt-stdlib/neg0.sema`.
