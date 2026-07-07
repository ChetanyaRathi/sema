---
name: "inexact->exact"
module: "math"
section: "Exactness Conversion"
params: [{ name: x, type: number }]
returns: "number"
---

Convert a number to its exact form. Finite floats are converted to their exact rational representation; inexact components of complex numbers are converted. Already-exact numbers are returned unchanged. `exact` is the shorter R7RS spelling of the same operation.

```sema
(inexact->exact 0.5)           ; => 1/2
(inexact->exact 2.0)           ; => 2 (normalizes to integer)
(inexact->exact 3.0+4.0i)      ; => 3+4i
```
