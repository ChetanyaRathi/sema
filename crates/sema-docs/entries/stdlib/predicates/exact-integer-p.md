---
name: "exact-integer?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a number is an exact integer (no fractional part, not a float). This combines `exact?` and `integer?`.

```sema
(exact-integer? 42)    ; => #t
(exact-integer? -17)   ; => #t
(exact-integer? 1/2)   ; => #f (not an integer)
(exact-integer? 2.0)   ; => #f (inexact)
(exact-integer? 3+0i)  ; => #t (exact integer with zero imaginary)
```
