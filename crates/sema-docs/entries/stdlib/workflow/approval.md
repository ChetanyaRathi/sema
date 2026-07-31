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

With no decision, the run ends `{:status :needs-approval …}` before later forms execute. `sema workflow run` prompts on a terminal by default. For a durable headless pause, create an approval key pair, pass the public-key file to `run`, then use the private-key file only with the separate `approve` or `reject` command. Decisions are Ed25519-signed and bound to the run, complete static import/package dependency closure, arguments, phase, key, occurrence, subject digest, request timestamp, and authority key. Imports and loads execute from the exact snapshotted bytes; files outside the preflight closure fail closed.

Approval is a sequential workflow gate. Put it before `parallel`, `pipeline`, async task combinators, steps, retry/timeout wrappers, resource-cleanup forms, or a nested workflow; the static checker rejects gates inside those constructs. The subject must be canonical immutable data (scalars, lists/vectors, maps, bytevectors, or typed numeric arrays). Pending, rejected, malformed, and authority-invalid gates cannot be bypassed with Sema `try`/`catch`.

See also: `workflow/approval`, `defworkflow`, `checkpoint`, `workflow/run`.
