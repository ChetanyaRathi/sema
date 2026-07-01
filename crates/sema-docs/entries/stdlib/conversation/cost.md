---
name: "conversation/cost"
module: "conversation"
params: [{ name: conv, type: conversation }]
returns: "float or nil"
---

Cumulative cost in USD, summed from each turn's actual token usage as it was sent (`conversation/say` folds the billed usage into the conversation). Returns `nil` when no priced turn has been recorded: an empty or hand-built conversation, or a model whose pricing is unknown.

```sema
(conversation/cost conv)   ; => 0.00028 (or nil)
```
