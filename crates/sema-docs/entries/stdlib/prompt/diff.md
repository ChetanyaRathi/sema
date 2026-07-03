---
name: "prompt/diff"
module: "prompt"
params: [{ name: a, type: prompt }, { name: b, type: prompt }]
returns: "map"
---

Structurally compares two prompts by `(role, content)`. Returns `{:added :removed}`: `:added` holds the messages present in `b` but not `a`, `:removed` those in `a` but not `b`. Useful for prompt versioning and review.

```sema
(prompt/diff prompt-v1 prompt-v2)
;; => {:added [...] :removed [...]}
```
