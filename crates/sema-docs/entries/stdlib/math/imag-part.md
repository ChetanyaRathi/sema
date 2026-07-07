---
name: "imag-part"
module: "math"
section: "Complex Accessors"
params: [{ name: z, type: number }]
returns: "number"
---

Return the imaginary part of a complex number. For real numbers, returns exact 0.

```sema
(imag-part 3+4i)       ; => 4
(imag-part 2.5)        ; => 0
(imag-part 1/3)        ; => 0
(imag-part 5i)         ; => 5
```
