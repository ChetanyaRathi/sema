---
name: "mutable-array/length"
module: "mutable"
section: "Mutable Containers"
params: [{ name: arr, type: mutable-array }]
returns: "int"
---

Return the number of elements currently in a mutable array (not its capacity).

```sema
(mutable-array/length (mutable-array/new 64))    ; => 0
(mutable-array/length (mutable-array/new 3 :x))  ; => 3
```
