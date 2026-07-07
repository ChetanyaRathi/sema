---
name: "make-polar"
module: "math"
section: "Complex Construction"
params: [{ name: magnitude, type: number }, { name: angle, type: number }]
returns: "number"
---

Construct a complex number from polar coordinates (magnitude and angle in radians). Converts to rectangular form internally. If the angle is zero or a multiple of π, returns a real number.

```sema
(make-polar 1 0)                 ; => 1
(make-polar 5 (math/atan2 3 4))  ; => 4.0+3.0i (approximately)
(make-polar 2 (/ math/pi 2))     ; => 0+2i (π/2 radians)
```
