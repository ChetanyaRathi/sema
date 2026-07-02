---
name: "prompt/intersection"
module: "prompt"
params: [{ name: a, type: prompt }, { name: b, type: prompt }]
returns: "prompt"
---

Returns a prompt of the messages present in both prompts, matched by `(role, content)`, in `a`'s order and de-duplicated.

```sema
(prompt/intersection prompt-a prompt-b)
```
