---
name: "conversation/map-role"
module: "conversation"
params: [{ name: conv, type: conversation }, { name: role, type: keyword }, { name: f }]
returns: "conversation"
---

Returns a new conversation where every message whose role is `role` is replaced by `(f msg)` — `f` receives a message and must return a message. Messages of other roles pass through unchanged. Contrast with `conversation/map`, which applies `f` to every message and returns a plain list of results.

```sema
(conversation/map-role conv :assistant
  (fn (m) (message :assistant (string/trim (message/content m)))))
```
