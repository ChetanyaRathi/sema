---
name: "conversation/remove"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: idx, type: int }]
returns: "conversation"
---

Returns a new conversation with the message at index `idx` removed — conversations are immutable, so the original is unchanged. Errors if `idx` is out of bounds.

```sema
(conversation/remove conv 2)   ; drop the message at index 2
```
