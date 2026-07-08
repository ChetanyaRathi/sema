---
name: "math/gcd"
module: "math"
section: "Integer Math"
params: [{ name: ns, type: integer, variadic: true }]
returns: "integer"
---

Greatest common divisor: the largest non-negative integer that divides all arguments. Variadic and bignum-aware; `(math/gcd)` with no arguments is `0` (the identity of the fold), per R7RS. Namespaced alias of [`gcd`](#gcd); pairs with [`math/lcm`](#math-lcm).

```sema
(math/gcd 12 8)     ; => 4
(math/gcd 15 10 25) ; => 5
(math/gcd 7 13)     ; => 1   ; coprime
(math/gcd)          ; => 0
```
