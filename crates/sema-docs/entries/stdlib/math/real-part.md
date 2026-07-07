---
name: "real-part"
module: "math"
section: "Complex Accessors"
params: [{ name: z, type: number }]
returns: "number"
---

Return the real part of a complex number. For real numbers, returns the number itself.

```sema
(real-part 3+4i)       ; => 3
(real-part 2.5)        ; => 2.5
(real-part 1/3)        ; => 1/3
(real-part 5i)         ; => 0
```
