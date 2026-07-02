---
name: "memory/append"
module: "memory"
section: "Agent Memory"
syntax: "(memory/append handle {:role role :content text})"
---

Append one conversation turn to a memory thread. The message is pushed onto the in-process
working set, persisted to the `.jsonl` sidecar immediately (append-only), and emits a
`Memory` journal event when called inside a `workflow/run`. Returns the `handle` so calls
can be chained.

- `:role` — `"user"` or `"assistant"` (defaults to `"user"` when absent).
- `:content` — message text string.

```sema
(define mem (memory/open {:id "chat-1"}))

(memory/append mem {:role "user"     :content "What files are in scope?"})
(memory/append mem {:role "assistant" :content "Found auth.rs and config.rs."})

;; pass the history to an agent — it sees the prior turns
(agent/run bot "Continue from where we left off." {:memory mem})
```

See also: `memory/open`, `memory/messages`, `memory/remember`.
