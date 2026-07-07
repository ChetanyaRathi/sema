---
name: "quotient"
module: "math"
section: "Integer Math"
params: [{ name: n, type: integer }, { name: d, type: integer }]
returns: "integer"
---

Truncated integer division: the result takes the sign of the dividend (truncates toward zero), per R7RS. Bignum-aware; both arguments must be exact integers. Pairs with [`remainder`](#remainder) so that `(+ (* (quotient n d) d) (remainder n d))` reconstructs `n`. Errors on a zero divisor.

```sema
(quotient 10 3)   ; => 3
(quotient -7 2)   ; => -3   ; truncates toward zero (not floored to -4)
(quotient 100000000000000000000 7) ; => 14285714285714285714
```
