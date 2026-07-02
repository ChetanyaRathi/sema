---
name: "conversation/replace"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: idx, type: int }, { name: message }]
returns: "conversation"
---

Returns a new conversation with the message at index `idx` replaced. The replacement is given either as a message value or as a `:role` keyword plus a content string. Errors if `idx` is out of bounds.

```sema
(conversation/replace conv 1 :user "What is Scheme?")
```
