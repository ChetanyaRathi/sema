---
name: "remainder"
module: "math"
section: "Integer Math"
params: [{ name: n, type: integer }, { name: d, type: integer }]
returns: "integer"
---

Remainder of truncated integer division: the result takes the sign of the dividend, per R7RS. Bignum-aware; both arguments must be exact integers. Pairs with [`quotient`](#quotient) so that `(+ (* (quotient n d) d) (remainder n d))` reconstructs `n`. Unlike [`modulo`](#modulo), the sign follows the dividend rather than the divisor. Errors on a zero divisor.

```sema
(remainder 10 3)   ; => 1
(remainder -7 2)   ; => -1   ; sign of the dividend
(remainder 7 -2)   ; => 1
```
