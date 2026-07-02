---
name: "conversation/turns"
module: "conversation"
params: [{ name: conv, type: conversation }]
returns: "int"
---

Number of assistant replies in the conversation — the count of completed user/assistant exchanges. Contrast with `conversation/length`, which counts every message.

```sema
(conversation/turns conv)   ; => 2
```
