---
name: "exact->inexact"
module: "math"
section: "Exactness Conversion"
params: [{ name: x, type: number }]
returns: "number"
aliases: ["inexact"]
---

Convert a number to inexact form (floating-point). All components are converted to `f64`. This is an alias for `inexact`; use either name.

```sema
(exact->inexact 1/3)        ; => 0.3333333333333333
(exact->inexact 42)         ; => 42.0
(exact->inexact 3+4i)       ; => 3.0+4.0i
```
