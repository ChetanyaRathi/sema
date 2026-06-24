---
name: "workflow/phase"
module: "workflow"
section: "Dynamic Workflows"
---

Run a labeled, journaled scope inside a workflow body. `(workflow/phase label thunk)` emits a `phase.started` event, evaluates `thunk`, then emits `phase.ended` (with `status` `"success"`/`"failed"`) — the end event is journaled even when the body errors, before the error propagates. A phase is a journaling boundary, not control flow; it returns the body's last value unchanged. Usually written via the [`phase`](/docs/stdlib/workflow/phase) macro.

```sema
(phase "Audit"
  (let ((files (checkpoint :files)))
    (checkpoint :findings (count files))))
```

See also: `phase`, `workflow/run`, `checkpoint`.
