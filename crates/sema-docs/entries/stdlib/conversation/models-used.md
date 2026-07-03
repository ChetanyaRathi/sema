---
name: "conversation/models-used"
module: "conversation"
params: [{ name: conv, type: conversation }]
returns: "list"
---

The models that produced replies in the conversation. A conversation carries a single configured model, so this is a one-element list of that model name — or an empty list when no model is set.

```sema
(conversation/models-used conv)   ; => ("gpt-4")
```
