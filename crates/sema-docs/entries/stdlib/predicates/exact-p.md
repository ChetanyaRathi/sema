---
name: "exact?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a number is exact (an integer or rational). Returns `#f` for inexact reals and complex numbers with any inexact component.

```sema
(exact? 42)        ; => #t
(exact? 1/3)       ; => #t
(exact? 3.14)      ; => #f
(exact? 3+4i)      ; => #t (both components exact)
(exact? 3.0+4i)    ; => #f (real component inexact)
```
