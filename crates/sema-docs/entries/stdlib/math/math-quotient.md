---
name: "math/quotient"
module: "math"
section: "Integer Math"
params: [{ name: n, type: integer }, { name: d, type: integer }]
returns: "integer"
---

Truncated integer division: the result takes the sign of the dividend (truncates toward zero), per R7RS. Bignum-aware; both arguments must be exact integers. Namespaced alias of [`quotient`](#quotient); pairs with [`math/remainder`](#math-remainder) so that `(+ (* (math/quotient n d) d) (math/remainder n d))` reconstructs `n`. Errors on a zero divisor.

```sema
(math/quotient 10 3)   ; => 3
(math/quotient -7 2)   ; => -3   ; truncates toward zero (not floored to -4)
(math/quotient 100000000000000000000 7) ; => 14285714285714285714
```
