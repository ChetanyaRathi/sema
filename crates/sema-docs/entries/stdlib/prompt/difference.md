---
name: "prompt/difference"
module: "prompt"
params: [{ name: a, type: prompt }, { name: b, type: prompt }]
returns: "prompt"
---

Returns a prompt of the messages in `a` that are not in `b`, matched by `(role, content)`, in `a`'s order and de-duplicated.

```sema
(prompt/difference prompt-a prompt-b)
```
