---
name: "lcm"
module: "math"
section: "Integer Math"
params: [{ name: ns, type: integer, variadic: true }]
returns: "integer"
---

Least common multiple: the smallest non-negative integer that every argument divides. Variadic and bignum-aware; `(lcm)` with no arguments is `1` (the identity of the fold), per R7RS. Pairs with [`gcd`](#gcd).

```sema
(lcm 4 6)      ; => 12
(lcm 2 3 4)    ; => 12
(lcm 7 13)     ; => 91  ; coprime
(lcm)          ; => 1
```
