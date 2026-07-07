---
name: "inexact?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a number is inexact (contains a floating-point component). Inexact numbers cannot represent all real values exactly and may have rounding errors.

```sema
(inexact? 42)      ; => #f
(inexact? 3.14)    ; => #t
(inexact? 1/3)     ; => #f (exact rational)
(inexact? 3.0+4i)  ; => #t (real component inexact)
```
