---
name: "prompt/union"
module: "prompt"
params: [{ name: a, type: prompt }, { name: b, type: prompt }]
returns: "prompt"
---

Returns a prompt containing the messages of `a` followed by those of `b`, de-duplicated by `(role, content)` with the first occurrence kept and order preserved. Matching is exact — it does not merge semantically similar instructions.

```sema
(prompt/union base-prompt safety-prompt)
```
