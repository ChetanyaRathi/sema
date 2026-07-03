---
name: "conversation/search"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: query, type: string }]
returns: "list"
---

Case-insensitive substring search over message content. Returns a list of `{:index :role :content}` maps, one per matching message.

```sema
(conversation/search conv "lisp")
;; => [{:index 1 :role :user :content "What is Lisp?"} ...]
```
