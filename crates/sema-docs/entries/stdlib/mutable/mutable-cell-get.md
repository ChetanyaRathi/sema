---
name: "mutable-cell/get"
module: "mutable"
section: "Mutable Containers"
params: [{ name: cell, type: mutable-cell }]
returns: "any"
---

Read the current contents of a mutable cell.

```sema
(define c (mutable-cell/new :ready))
(mutable-cell/get c)   ; => :ready
```
