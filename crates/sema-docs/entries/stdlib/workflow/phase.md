---
name: "phase"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(phase label body ...)"
---

Macro: a labeled, journaled scope inside a workflow body. `(phase label body…)` expands to `(workflow/phase label (lambda () body…))`, emitting `phase.started`/`phase.ended` events around the body (the end event is journaled even if the body errors). A phase is a journaling boundary, not control flow — it returns the body's last value unchanged. Use it to group the steps of a workflow into inspectable sections in the run journal.

```sema
(phase "Inventory"
  (checkpoint :files (list "a.php" "b.php" "c.php")))
```

See also: `defworkflow`, `workflow/phase`, `checkpoint`.
