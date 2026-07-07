---
name: "numerator"
module: "math"
section: "Rational Accessors"
params: [{ name: x, type: number }]
returns: "integer"
---

Return the numerator of a rational number. For integers, returns the integer itself. For floats, no-op (floats have no rational decomposition).

```sema
(numerator 22/7)    ; => 22
(numerator 1/2)     ; => 1
(numerator 42)      ; => 42
```
