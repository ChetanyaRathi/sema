---
name: "angle"
module: "math"
section: "Complex Polar Conversion"
params: [{ name: z, type: number }]
returns: "number"
---

Return the angle (argument) of a complex number in radians, in the range (-π, π]. For a complex number a+bi, returns atan2(b, a). For a positive real number, returns 0; for a negative real number, returns π.

```sema
(angle 3+4i)           ; => 0.9273 (atan2(4, 3))
(angle 5)              ; => 0.0
(angle -5)             ; => 3.1416 (π)
(angle 0+1i)           ; => 1.5708 (π/2)
```
