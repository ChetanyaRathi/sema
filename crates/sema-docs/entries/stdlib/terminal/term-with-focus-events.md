---
name: "term/with-focus-events"
module: "terminal"
section: "Screen Control"
---

Guard macro: enable focus reporting, run `body`, and **always** disable it on exit — even if `body` throws. Returns `body`'s value. Inside, `io/read-key` returns focus changes as `{:kind :focus :focused #t|#f}`.
