---
name: "math/remainder"
module: "math"
section: "Integer Math"
params: [{ name: n, type: integer }, { name: d, type: integer }]
returns: "integer"
---

Remainder of truncated integer division: the result takes the sign of the dividend, per R7RS. Bignum-aware; both arguments must be exact integers. Namespaced alias of [`remainder`](#remainder); pairs with [`math/quotient`](#math-quotient) so that `(+ (* (math/quotient n d) d) (math/remainder n d))` reconstructs `n`. Errors on a zero divisor.

```sema
(math/remainder 10 3)  ; => 1
(math/remainder -7 2)  ; => -1   ; sign of the dividend
(math/remainder 7 -2)  ; => 1
```
