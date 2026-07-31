---
name: "defpolicy"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(defpolicy name policy-map)"
---

Define a reusable model and tool policy. Model rules match exact
`"provider/model"` identities or the `"provider/*"` wildcard. Tool rules can
allow or deny tool names and constrain model-supplied path, URL, and command
arguments. A present `:models` or `:tools` section defaults to `:deny`.

```sema
(defpolicy repository-auditor
  {:models {:default :deny
            :allow ["openai/gpt-5" "anthropic/*"]}
   :tools {:default :deny
           :allow
           {"read-file" {:paths ["src/**" "Cargo.toml"]}
            "run-command" {:commands ["cargo test" "cargo check"]}}}})

(defworkflow audit "Guarded audit" {:policy repository-auditor}
  (phase "Audit")
  (step "Inspect the repository."
        {:tools [read-file run-command]})
  {:status :success})
```

Attach a policy with workflow or step `:policy`. Active workflow and step
policies compose with logical AND. `:permissions` and the CLI sandbox remain the
outer capability limit.

See also: `defworkflow`, `step`, `policy/without`, `workflow/check`.
