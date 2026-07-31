---
name: "approval"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(approval key {:reason string :subject value [:preview string]})"
---

Stop a workflow at a durable, host-controlled human approval gate. `key` is a keyword or string. `:reason` explains why approval is required, `:subject` identifies the exact action and is stored only as a SHA-256 digest, and optional `:preview` is operator-safe text that may be written to the request sidecar and shown in a prompt.

```sema
(approval :release-signoff
  {:reason "Publish the release"
   :subject {:kind :external-action
             :target "pkg.sema-lang.com"
             :digest package-digest}
   :preview "Publish sema-policies@1.0.0"})
```

With no decision, the run ends `{:status :needs-approval …}` before later forms execute. `sema workflow run` prompts on a terminal by default, or exits 3 headlessly. Approve or reject with `sema workflow approve` / `sema workflow reject`, then resume the same run. An approval decision is bound to the run, workflow code and arguments, phase, key, occurrence, and subject digest; changing any binding creates a new request. Pending and rejected gates cannot be bypassed with Sema `try`/`catch`.

See also: `workflow/approval`, `defworkflow`, `checkpoint`, `workflow/run`.
