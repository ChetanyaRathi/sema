---
name: "number->string"
module: "math"
section: "Number/String Conversion"
params: [{ name: n, type: number }, { name: radix, type: integer, doc: "Optional radix (2, 8, 10, or 16); default 10" }]
returns: "string"
---

Convert a number to its string representation. An optional radix parameter (2, 8, 10, or 16) selects the base for the output; only exact integers can be converted to bases other than 10.

```sema
(number->string 42)           ; => "42"
(number->string 1/3)          ; => "1/3"
(number->string 3.14)         ; => "3.14"
(number->string 3+4i)         ; => "3+4i"
(number->string 255 16)       ; => "ff"
(number->string 5 2)          ; => "101"
```
