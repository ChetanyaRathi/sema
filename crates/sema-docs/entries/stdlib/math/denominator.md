---
name: "denominator"
module: "math"
section: "Rational Accessors"
params: [{ name: x, type: number }]
returns: "integer"
---

Return the denominator of a rational number. For integers, returns 1 (since an integer n is n/1). For floats, no-op (floats have no rational decomposition).

```sema
(denominator 22/7)    ; => 7
(denominator 1/2)     ; => 2
(denominator 42)      ; => 1
```
