---
name: "exact-integer-sqrt"
module: "math"
section: "Integer Square Root"
params: [{ name: n, type: integer }]
returns: "list"
---

Compute the integer square root of a non-negative integer. Returns a list `(s r)` where `s²+r = n`, `0 ≤ r`, and both are exact integers. This works for arbitrarily large bignums.

```sema
(exact-integer-sqrt 17)        ; => (4 1)    ; 4²+1 = 17
(exact-integer-sqrt 100)       ; => (10 0)
(exact-integer-sqrt 0)         ; => (0 0)
(exact-integer-sqrt 1000000)   ; => (1000 0)
```
