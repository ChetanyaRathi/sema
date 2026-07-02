---
name: "conversation/length"
module: "conversation"
params: [{ name: conv, type: conversation }]
returns: "int"
---

Number of messages in the conversation — system, user, and assistant messages are all counted. Contrast with `conversation/turns`, which counts only assistant replies.

```sema
(conversation/length conv)   ; => 4
```
