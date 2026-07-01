---
name: "conversation/insert"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: idx, type: int }, { name: message }]
returns: "conversation"
---

Returns a new conversation with a message inserted before index `idx`; passing `idx` equal to the length appends. The message is given either as a message value or as a `:role` keyword plus a content string. Errors if `idx` is out of bounds.

```sema
(conversation/insert conv 1 :system "Additional context.")
(conversation/insert conv 1 (message :system "Additional context."))
```
