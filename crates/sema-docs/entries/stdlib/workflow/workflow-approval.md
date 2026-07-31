---
name: "workflow/approval"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(workflow/approval key opts)"
---

Backend for the `approval` macro. Atomically creates or reads the approval request and immutable decision sidecars under the active run's `approvals/` directory. Filesystem work is offloaded from the cooperative VM. A pending or rejected decision stops the workflow with an internal, uncatchable control transfer that the enclosing `workflow/run` converts to a `:needs-approval` or `:rejected` envelope. An approved decision emits `approval.granted` and `approval.applied`, then returns `#t`.

Use the public `approval` macro in workflow source.

See also: `approval`, `workflow/run`, `defworkflow`.
