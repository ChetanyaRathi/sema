---
name: "exact"
module: "math"
section: "Exactness Conversion"
params: [{ name: x, type: number }]
returns: "number"
---

Convert a number to its exact form. Finite floats are converted to their exact rational representation; inexact components of complex numbers are converted. Already-exact numbers are returned unchanged.

```sema
(exact 0.5)           ; => 1/2
(exact 2.0)           ; => 2 (normalizes to integer)
(exact 3.14159)       ; => a rational very close to pi
(exact 1/3)           ; => 1/3 (already exact)
(exact 3.0+4.0i)      ; => 3+4i
```
