//! Exact numeric comparison across the int/float boundary.
//!
//! The naive `a as f64` cast used by mixed-type `=`/`<`/`>` is lossy above
//! 2^53: it collapses adjacent integers onto the same float, so distinct
//! numbers compare equal (`(= 9007199254740993 9007199254740992.0)` → `#t`).
//! [`cmp_int_float`] compares an `i64` and an `f64` exactly instead, and is the
//! single source of truth shared by the VM (`vm_eq`/`vm_lt`) and the stdlib
//! first-class `=`/`<`/`>` functions.

use std::cmp::Ordering;

/// Compare an `i64` against an `f64` *exactly*, without any lossy cast. Returns
/// `None` only when `b` is NaN, matching IEEE's unordered semantics (callers
/// treat `None` as "comparison false").
pub fn cmp_int_float(a: i64, b: f64) -> Option<Ordering> {
    if b.is_nan() {
        return None;
    }
    // Floats outside the i64 range: the sign decides without inspecting `a`.
    // 2^63 and -2^63 are exactly representable in f64.
    if b >= 9_223_372_036_854_775_808.0 {
        return Some(Ordering::Less); // a < 2^63 ≤ b
    }
    if b < -9_223_372_036_854_775_808.0 {
        return Some(Ordering::Greater); // a ≥ -2^63 > b
    }
    // b is now within [-2^63, 2^63): truncation toward zero is exact and in range.
    let bt = b.trunc();
    let bi = bt as i64;
    match a.cmp(&bi) {
        Ordering::Equal if b > bt => Some(Ordering::Less), // a == bt, b has a positive fraction
        Ordering::Equal if b < bt => Some(Ordering::Greater), // b has a negative fraction
        ord => Some(ord),                                  // integral b, or a ≠ bt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_above_2_pow_53() {
        // 2^53 + 1 (int) vs 2^53 (float): distinct, int is larger.
        assert_eq!(
            cmp_int_float(9_007_199_254_740_993, 9_007_199_254_740_992.0),
            Some(Ordering::Greater)
        );
        // Exactly equal at 2^53.
        assert_eq!(
            cmp_int_float(9_007_199_254_740_992, 9_007_199_254_740_992.0),
            Some(Ordering::Equal)
        );
    }

    #[test]
    fn fractions_and_small_values() {
        assert_eq!(cmp_int_float(1, 1.5), Some(Ordering::Less));
        assert_eq!(cmp_int_float(2, 1.5), Some(Ordering::Greater));
        assert_eq!(cmp_int_float(-2, -1.5), Some(Ordering::Less));
        assert_eq!(cmp_int_float(-2, -2.5), Some(Ordering::Greater));
        assert_eq!(cmp_int_float(0, 0.0), Some(Ordering::Equal));
    }

    #[test]
    fn out_of_range_and_nan() {
        assert_eq!(cmp_int_float(5, 1e300), Some(Ordering::Less));
        assert_eq!(cmp_int_float(5, -1e300), Some(Ordering::Greater));
        assert_eq!(
            cmp_int_float(i64::MAX, 9_223_372_036_854_775_808.0),
            Some(Ordering::Less)
        );
        assert_eq!(
            cmp_int_float(i64::MIN, -9_223_372_036_854_775_808.0),
            Some(Ordering::Equal)
        );
        assert_eq!(cmp_int_float(1, f64::NAN), None);
    }
}
