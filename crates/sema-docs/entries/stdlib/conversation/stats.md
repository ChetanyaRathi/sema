---
name: "conversation/stats"
module: "conversation"
params: [{ name: conv, type: conversation }]
returns: "map"
---

Aggregate report over the conversation: `{:messages :turns :tokens {:prompt :completion :total} :cost :models}`. The token and cost figures come from the real usage `conversation/say` accumulates as each turn is sent; they are `0` / `nil` when no priced turn has been recorded, and `:cost` is `nil` for a model with no known pricing.

```sema
(conversation/stats conv)
;; => {:messages 4 :turns 2 :tokens {:prompt 200 :completion 40 :total 240} :cost 0.00028 :models ("gpt-4")}
```
