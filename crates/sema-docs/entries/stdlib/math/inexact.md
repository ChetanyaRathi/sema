---
name: "inexact"
module: "math"
section: "Exactness Conversion"
params: [{ name: x, type: number }]
returns: "number"
---

Convert a number to inexact form (floating-point). All components are converted to `f64`. Useful for inexact contagion or for forcing floating-point arithmetic.

```sema
(inexact 1/3)        ; => 0.3333333333333333
(inexact 42)         ; => 42.0
(inexact 3+4i)       ; => 3.0+4.0i
(inexact 3.14)       ; => 3.14 (already inexact)
```
