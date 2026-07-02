---
name: "memory/recall-fact"
module: "memory"
section: "Agent Memory"
syntax: "(memory/recall-fact handle :key)"
---

Return the fact stored under `:key` in a memory thread, or `nil` if no such fact has been
written. Reads from the in-process working set (which is loaded from `.facts.json` when
`memory/open` is called), so the value is available without an extra I/O call.

```sema
(define mem (memory/open {:id "project-ctx"}))
(memory/remember mem :phase "audit")

(memory/recall-fact mem :phase)        ; => "audit"
(memory/recall-fact mem :missing-key)  ; => nil
```

See also: `memory/remember`, `memory/open`.
