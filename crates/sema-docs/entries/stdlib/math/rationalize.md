---
name: "rationalize"
module: "math"
section: "Rational Approximation"
params: [{ name: x, type: number }, { name: tol, type: number }]
returns: "rational"
---

Find the simplest rational number within `tol` of the given number `x`. Uses the Stern-Brocot tree algorithm to find the rational with the smallest denominator in the error interval. Useful for finding readable rational approximations to irrational or transcendental numbers.

```sema
(rationalize 0.333333 1/1000)  ; => 1/3
(rationalize 3.14159 1/100)    ; => 22/7
(rationalize 1/2 0.01)         ; => 1/2
```
