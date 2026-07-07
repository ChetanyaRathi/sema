---
name: "rational?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a number is rational (exact and representable as a ratio of integers). Every integer is rational. Returns `#f` for floats and complex numbers.

```sema
(rational? 42)     ; => #t
(rational? 1/3)    ; => #t
(rational? 3.14)   ; => #f (inexact)
(rational? 3+4i)   ; => #f (complex)
```
