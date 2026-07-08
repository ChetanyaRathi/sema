---
name: "math/lcm"
module: "math"
section: "Integer Math"
params: [{ name: ns, type: integer, variadic: true }]
returns: "integer"
---

Least common multiple: the smallest non-negative integer that every argument divides. Variadic and bignum-aware; `(math/lcm)` with no arguments is `1` (the identity of the fold), per R7RS. Namespaced alias of [`lcm`](#lcm); pairs with [`math/gcd`](#math-gcd).

```sema
(math/lcm 4 6)     ; => 12
(math/lcm 2 3 4)   ; => 12
(math/lcm 7 13)    ; => 91   ; coprime
(math/lcm)         ; => 1
```
