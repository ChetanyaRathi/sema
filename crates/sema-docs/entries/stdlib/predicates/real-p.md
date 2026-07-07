---
name: "real?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a number is real (has no non-zero imaginary part). All integers, rationals, and floating-point numbers are real.

```sema
(real? 42)      ; => #t
(real? 3.14)    ; => #t
(real? 1/3)     ; => #t
(real? 3+4i)    ; => #f
(real? 3+0i)    ; => #t (imaginary part is exact zero)
```
