---
name: "exact->inexact"
module: "math"
section: "Exactness Conversion"
params: [{ name: x, type: number }]
returns: "number"
---

Convert a number to inexact form (floating-point). All components are converted to `f64`. Identical to [`inexact`](./inexact) — both names are registered (R7RS `exact->inexact` and the shorthand `inexact`); use either.

```sema
(exact->inexact 1/3)        ; => 0.3333333333333333
(exact->inexact 42)         ; => 42.0
(exact->inexact 3+4i)       ; => 3.0+4.0i
```
