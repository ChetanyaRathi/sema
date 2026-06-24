---
name: "defworkflow"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(defworkflow name doc meta body ...)"
---

Macro: define and run a sequential, journaled workflow. `(defworkflow name "doc" meta body…)` expands to `(workflow/run "name" "doc" meta (lambda () body…))` — so the form *is* the run: it opens the run directory, journals every event, and returns the `{:status …}` envelope. `meta` is a metadata map (`{:args … :budget … :perms …}`) recorded into `metadata.json`. The body is ordinary Sema code, conventionally a sequence of [`phase`](/docs/stdlib/workflow/phase) scopes ending in a `{:status …}` map. Keeping `defworkflow` a prelude macro leaves the VM untouched.

```sema
(defworkflow audit-auth
  "Audit a codebase for missing authorization checks."
  {:args {:paths [:list :string]}}
  (phase "Inventory" (checkpoint :files (list "a.php" "b.php")))
  (phase "Audit"     (checkpoint :findings (count (checkpoint :files))))
  {:status :success :findings (checkpoint :findings)})
```

Run a workflow file with `sema workflow run <file> --args <json>`.

See also: `workflow/run`, `phase`, `checkpoint`.
