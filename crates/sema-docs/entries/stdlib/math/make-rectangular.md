---
name: "make-rectangular"
module: "math"
section: "Complex Construction"
params: [{ name: real, type: number }, { name: imag, type: number }]
returns: "number"
---

Construct a complex number from real and imaginary parts. If the imaginary part is exact zero and the real part is real (not complex), returns just the real part.

```sema
(make-rectangular 3 4)       ; => 3+4i
(make-rectangular 2 0)       ; => 2 (imaginary part is exact zero)
(make-rectangular 3.5 2.0)   ; => 3.5+2.0i
(make-rectangular 1/3 1/2)   ; => 1/3+1/2i
```
