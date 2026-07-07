---
name: "magnitude"
module: "math"
section: "Complex Polar Conversion"
params: [{ name: z, type: number }]
returns: "number"
---

Return the magnitude (absolute value) of a complex number. For a complex number a+bi, returns √(a²+b²). For real numbers, returns the absolute value.

```sema
(magnitude 3+4i)       ; => 5.0
(magnitude -5)         ; => 5
(magnitude 1/3)        ; => 1/3
(magnitude 0)          ; => 0
```
