---
name: "gcd"
module: "math"
section: "Integer Math"
params: [{ name: ns, type: integer, variadic: true }]
returns: "integer"
---

Greatest common divisor: the largest non-negative integer that divides all arguments. Variadic and bignum-aware; `(gcd)` with no arguments is `0` (the identity of the fold), per R7RS. Pairs with [`lcm`](#lcm).

```sema
(gcd 12 8)     ; => 4
(gcd 15 10 25) ; => 5
(gcd 7 13)     ; => 1   ; coprime
(gcd)          ; => 0
```
