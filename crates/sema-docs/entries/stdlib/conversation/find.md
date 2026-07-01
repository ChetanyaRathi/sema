---
name: "conversation/find"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: pred }]
returns: "message or nil"
---

Returns the first message for which `(pred msg)` is truthy, or `nil` if none match. Like `conversation/filter`, but returns just the first hit rather than a filtered conversation.

```sema
(conversation/find conv (fn (m) (= (message/role m) :assistant)))
```
