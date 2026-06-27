---
name: "memory/remember"
module: "memory"
section: "Agent Memory"
syntax: "(memory/remember handle :key value)"
---

Store a named fact in a memory thread (last-write-wins). The fact is written to the
`.facts.json` sidecar immediately (full snapshot overwrite) and emits a `Memory` journal
event inside a `workflow/run`. Returns the `handle`.

- `:key` — keyword naming the fact slot.
- `value` — any Sema value; serialized to JSON via lossy conversion.

```sema
(define mem (memory/open {:id "project-ctx"}))

(memory/remember mem :last-reviewed-file "src/auth.rs")
(memory/remember mem :issue-count 3)

;; retrieve later, even across workflow runs
(memory/recall-fact mem :last-reviewed-file)  ; => "src/auth.rs"
```

See also: `memory/recall-fact`, `memory/open`, `memory/append`.
