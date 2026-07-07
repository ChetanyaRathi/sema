---
name: "complex?"
module: "predicates"
section: "Numeric Predicates"
params: [{ name: v, type: any }]
returns: "bool"
---

Test if a value is a complex number (a number of any type, since all numbers in the numeric tower are complex in the abstract algebra sense). In R7RS, every number is considered complex.

```sema
(complex? 42)      ; => #t
(complex? 3.14)    ; => #t
(complex? 1/3)     ; => #t
(complex? 3+4i)    ; => #t
(complex? "hi")    ; => #f
```
