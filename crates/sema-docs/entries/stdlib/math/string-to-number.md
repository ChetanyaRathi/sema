---
name: "string->number"
module: "math"
section: "Number/String Conversion"
params: [{ name: s, type: string }, { name: radix, type: integer, doc: "Optional radix (2, 8, 10, or 16); default 10" }]
returns: "number or #f"
---

Parse a string as a number. Returns `#f` if the string is not a valid number. Supports integers, rationals (1/3), floats (3.14), complex (3+4i), and radix prefixes when radix is specified. With radix != 10, parses the string as an integer in that base.

```sema
(string->number "42")         ; => 42
(string->number "1/3")        ; => 1/3
(string->number "3.14")       ; => 3.14
(string->number "3+4i")       ; => 3+4i
(string->number "ff" 16)      ; => 255
(string->number "101" 2)      ; => 5
(string->number "nope")       ; => #f
```
