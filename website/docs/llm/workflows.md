---
outline: [2, 3]
---

# Workflows

Sema's workflow runtime lets you define multi-phase agentic workflows as ordinary
Sema code. Every phase, step call, checkpoint, and budget charge is journaled
to a frozen JSONL run directory. Crash, edit, and resume — the runtime skips
leaves that already completed and only re-runs what changed.

## Quick start

```bash
# Run a workflow file
sema workflow run my-workflow.sema --args '{"topic":"rust"}' --view

# Resume after a crash or edit
sema workflow run my-workflow.sema --resume wf_1719494_12345

# Statically validate without calling any LLM
sema workflow check my-workflow.sema

# Open the web viewer for past runs
sema workflow view --run-dir .sema/runs
```

## The DSL

### `defworkflow`

A prelude macro that expands to `workflow/run`. The body is a thunk (an
implicit `lambda`); the form **is** the run — when Sema evaluates it, the
runtime opens a journal, emits events, and returns a `{:status …}` envelope.

```sema
(defworkflow name "doc string" meta-map
  body-form-1
  body-form-2
  ...)
```

The `meta-map` supports:

| Key | Type | Description |
|-----|------|-------------|
| `:phases` | `[:string …]` | Declared phase plan — the dashboard shows all phases up front |
| `:budget` | `{:tokens N :usd M}` | Spend caps (see [Budget Enforcement](#budget-enforcement)) |
| `:permissions` | string | Sandbox restrictions for `sema workflow run`, using the same syntax as `--sandbox` |
| `:policy` | policy | Model/tool allowlist for this workflow (see [Model and tool policies](#model-and-tool-policies)) |
| `:args` | map | Argument schema (informational; the actual args come from `--args`) |

The body is ordinary Sema code. `phase` markers interleave with `def`,
`step`, `checkpoint`, `parallel`, `pipeline`, and any other Sema forms. The
last value is the return envelope — if it's already a `{:status …}` map it
passes through; otherwise the runtime wraps it as `{:status :success :value …}`.

### `phase`

A **marker**, not a wrapper. `(phase "Audit")` closes the previously-open
phase and opens "Audit". Every `step`, `checkpoint`, and `budget` event that
follows attributes to it until the next `(phase …)` or the run end (which
closes the last open phase). Returns `nil`.

```sema
(phase "Inventory")
;; forms here belong to "Inventory"
(checkpoint :files (list "a.php" "b.php"))

(phase "Audit")
;; forms here belong to "Audit"
(define findings (step "Audit each file" {:name "auditor"}))
```

::: tip
`phase` takes exactly one argument — the label. It is NOT a wrapper like
`let` or `when`. A common mistake is `(phase "Audit" (do-stuff))` — the
correct form is `(phase "Audit")` followed by the body forms.
:::

### `step`

A journaled LLM leaf — the workflow's atomic orchestration unit. The `step` macro
wraps `workflow/step` and handles prompt resolution, schema validation, tool
dispatch, and `:agent` routing.

```sema
;; Without schema — returns the completion text
(step "Summarize the changelog.")

;; With schema — returns typed data (validated via llm/extract)
(step "List auth-relevant files."
      {:name "scout"
       :schema [:list :string]})

;; With tools — runs the real tool loop (llm/chat)
(step "Find TODOs in src/"
      {:name "coder"
       :tools [read-file run-command]})

;; With :agent — runs a configured defagent as this step
(step "Review this file" {:agent code-reviewer :schema verdict})
```

The opts map supports:

| Key | Type | Description |
|-----|------|-------------|
| `:name` | `:string` | Role label shown in the dashboard (default `"step"`) |
| `:schema` | schema spec | Typed extraction — the step returns a validated map, not text |
| `:tools` | `[tool …]` | Tool-calling loop — the step runs `llm/chat` with tool dispatch |
| `:agent` | `defagent` | Run a configured `defagent` as this step via `agent/run` |
| `:policy` | policy | Additional restrictions for this step; it cannot loosen the workflow policy |

When `:agent` is present, the defagent owns its own tools and model — inline
`:tools`/`:model` are ignored (the static checker warns if both are given).

The runtime emits `agent.started` before the leaf and `agent.result` after,
plus a per-step `budget` event with token/cost attribution. (The `agent.*`
event names are the frozen journal contract — they predate the `step` rename.)

### `checkpoint`

Records a keyed step value and returns it. With one argument, reads the
previously-stored value back.

```sema
;; Write: store the files list under :files, return it
(checkpoint :files (list "a.php" "b.php"))

;; Read: get the value back (nil if never set)
(let ((files (checkpoint :files)))
  (count files))
```

Checkpoints double as the run-scoped state bag — values stored in one phase
are readable in a later phase. Each checkpoint emits a `checkpoint` event
with a `content_key`, an opaque value digest, and a capped display value; the
memo sidecar stores the canonical value for resume.

### `approval`

Stops before a sensitive action until a host records an approve or reject
decision. The subject is used only to bind the decision; the request sidecar
stores its SHA-256 digest, not the raw value. Put only operator-safe text in
`:preview`.

```sema
(approval :release-signoff
  {:reason "Publish the release"
   :subject {:kind :external-action
             :target "pkg.sema-lang.com"
             :digest package-digest}
   :preview "Publish sema-policies@1.0.0"})

;; This does not run until the request is approved.
(publish-package)
```

The default `auto` mode prompts when stdin and stderr are terminals and `CI`
is unset. The prompt accepts approve, reject with a reason, or quit-pending.
Ctrl-C exits with code 130 and leaves the durable request pending; it never
turns an interrupted prompt into a rejection.

Terminal prompts use an ephemeral Ed25519 authority kept in host memory. The
CLI records the signed decision, creates a fresh interpreter, and resumes the
same run immediately. If you quit an ephemeral prompt without deciding, start
a fresh run: its private authority intentionally cannot be recovered from the
workflow or its sidecars.

For CI, automation, or a decision made from another terminal, create a durable
authority and pass only its public key to the workflow process:

```bash
# Create the authority once. The private file is created with mode 0600.
mkdir -p .sema
sema workflow approval-keygen \
  --private-key-file .sema/approval.private \
  --public-key-file .sema/approval.public

# Pause at a gate and return exit code 3. Keep the exact file, args, run dir,
# and public-key file for the later resume command.
sema workflow run release.sema \
  --args '{"package":"sema-policies","version":"1.0.0"}' \
  --approval-mode pause \
  --approval-public-key-file .sema/approval.public

# The command prints the concrete run id and approval id. You can also list
# pending requests as text or JSON.
sema workflow approvals wf_…
sema workflow approvals wf_… --json

# Approve from a separate trusted process. The private key is never passed to
# `workflow run` and is never visible to Sema code.
sema workflow approve wf_… apr_… \
  --signing-key-file .sema/approval.private \
  --actor release-manager \
  --comment 'verified package and version'

# Or reject; a reason is required.
sema workflow reject wf_… apr_… \
  --signing-key-file .sema/approval.private \
  --actor release-manager \
  --reason 'release checks failed'

# Apply the recorded decision. Reuse the exact original inputs.
sema workflow run release.sema \
  --args '{"package":"sema-policies","version":"1.0.0"}' \
  --resume wf_… \
  --approval-mode pause \
  --approval-public-key-file .sema/approval.public
```

The loopback workflow viewer can record the same signed decision. Give the
private key only to the host process that serves the viewer:

```bash
# Inspect existing runs and enable controls for requests from this authority.
sema workflow view \
  --run-dir .sema/runs \
  --approval-signing-key-file .sema/approval.private \
  --approval-actor release-manager

# Or start the viewer with the workflow. A signing key implies a durable pause
# when the default mode is auto.
sema workflow run release.sema \
  --args '{"package":"sema-policies","version":"1.0.0"}' \
  --view \
  --approval-signing-key-file .sema/approval.private \
  --approval-actor release-manager
```

The private key stays in the host viewer state. It is not placed in the Sema
environment, returned by the API, or written to the run directory. The viewer
shows validated request summaries. A pending request is inspect-only when the
viewer has no signing key or its key does not match the request authority.
After approve or reject, resume the same run with the exact original file,
arguments, run directory, and authority. The viewer displays the durable winner
when another process wins the compare-and-set race.

| Mode | Behavior |
|------|----------|
| `auto` | Prompt on a real terminal outside CI; otherwise use `pause` behavior |
| `prompt` | Require terminal stdin/stderr and ask approve, reject, or leave pending |
| `pause` | Publish a request and exit 3; a durable gate requires `--approval-public-key-file` |
| `deny` | Refuse the gate without recording an approval decision and exit 1 |

The request and decision JSON files under the run's `approvals/` directory are
the protocol authority; journal events are audit evidence. Decisions use
Ed25519 signatures and compare-and-set publication, so the first approve or
reject wins and a conflicting decision cannot overwrite it. A decision binds
the run, complete static import/package dependency closure, arguments, phase,
gate key and occurrence, canonical subject digest, request timestamp, request
revision, and public authority. Editing a binding invalidates the decision.
The evaluator reads imports and loads from those exact snapshotted bytes;
runtime-selected or macro-generated files outside the preflight closure fail
closed instead of escaping the approval revision.

Approval subjects must be canonical immutable data: scalars, lists, vectors,
maps, bytevectors, or typed numeric arrays. Mutable cells, records, functions,
promises, channels, and other runtime objects are rejected instead of being
hashed through an ambiguous display string. The raw subject is never stored;
only its digest is. Treat `:preview`, `:reason`, comments, and actor names as
operator-visible text.

An approval is a sequential gate in the owning workflow task. Call `approval`
directly; `workflow/approval` cannot be aliased, stored, or passed as a
first-class value. Put the gate before, not inside, `parallel`, `pipeline`,
async task combinators, steps, retry/timeout forms, resource-cleanup forms, or a
nested `workflow/run`. `sema workflow check` and `sema workflow run` reject
those placements before execution. Pending, rejected, malformed, cancelled,
and authority-invalid gates are uncatchable by Sema `try`/`catch`, so later
protected forms cannot run.

Durable approval storage and approval key generation support Unix permission
modes and protected Windows ACLs. Other targets fail closed if Sema cannot
enforce private approval files.

### `parallel`

Runs a list of zero-arg thunks concurrently with bounded concurrency (default
8). A **barrier** — waits for all thunks before returning. Results come back
in input order. A thunk that throws yields `nil` in its slot (the batch never
aborts).

```sema
;; Fetch two URLs concurrently
(parallel
  (list (fn () (http/get url-a))
        (fn () (http/get url-b))))

;; Override the concurrency cap
(parallel thunks 4)
```

### `pipeline`

Each item flows through all stage functions independently — **no barrier
between stages**. Item A can be in stage 3 while item B is still in stage 1.
A stage that throws drops that item to `nil` and skips its remaining stages.
Results align to `items` (nils for dropped).

```sema
;; Each file → audit → verify
(pipeline files
  (fn (f) (step (str "Audit " f) {:name "auditor"}))
  (fn (x) (step (str "Verify " (:claim x)) {:name "verifier"})))
```

## The run directory

Every `sema workflow run` creates a run directory under `.sema/runs/<run-id>/`:

```
.sema/runs/wf_1719494_12345/
  events.jsonl              # the system of record (append-only)
  events.resume-1.jsonl     # one per --resume continuation
  memo/                     # per-leaf resume cache
    3f13d37d3df7b337_0.json #   content-key → memoized value
    7b03b1d77c616601_0.json
  approvals/                # authoritative human approval protocol
    apr_….request.json
    apr_….decision.json
  metadata.json             # workflow name, code version, budget, permissions
  result.json               # the final {:status …} envelope
```

### Event vocabulary

Existing event shapes are **frozen** — add fields only as append-only,
optional/skippable fields, and add new event kinds without changing old ones.
Old runs stay readable forever.

| Event | Key fields | Description |
|-------|-----------|-------------|
| `run.started` | `workflow`, `run_id`, `code_version`, `args_json`, `phases` | First line of every run |
| `phase.started` | `phase` | A phase opened |
| `phase.ended` | `phase`, `status`, `dur_ms` | A phase closed (paired with `phase.started`) |
| `agent.started` | `agent_id`, `agent_name`, `model` | An agent leaf began |
| `agent.result` | `agent_id`, `status`, `output`, `dur_ms`, `model` | An agent leaf produced a result |
| `agent.tool_call` | `agent_id`, `tool_name`, `args_json` | An agent invoked a tool |
| `agent.tool_result` | `agent_id`, `tool_name` | An agent tool call completed successfully |
| `policy.checked` | `policy`, `boundary`, `subject`, `rule`, `source` | A policy layer allowed a protected boundary |
| `policy.violation` | `policy`, `boundary`, `subject`, `rule`, `action`, `source` | A policy layer denied a protected boundary |
| `policy.bypassed` | `policy`, `boundary`, `subject`, `reason`, `source` | A lexical `policy/without` scope bypassed a protected boundary |
| `approval.requested` | `approval_id`, `request_digest`, `key`, `reason`, `subject_digest` | A durable request stopped the run |
| `approval.granted` | `approval_id`, `decision_id`, `actor`, `provenance` | An approved decision was observed on resume |
| `approval.rejected` | `approval_id`, `decision_id`, `actor`, `reason` | A rejected decision was observed on resume |
| `approval.applied` | `approval_id`, `decision_id` | Execution crossed an approved gate |
| `checkpoint` | `key`, `content_key`, `value_digest`, `value` | A checkpoint was recorded |
| `budget` | `agent_id`, `input_tokens`, `output_tokens`, `cost_usd`, `budget_limit` | A per-leaf budget observation |
| `run.ended` | `status`, `reason`, `dur_ms` | Last line of every run |

Each event carries a monotonic `seq` (0-based) and a `ts` (RFC3339 UTC
instant). The journal is flushed per event, so a crash mid-run leaves a valid
JSONL prefix.

## Resume

`--resume <run-id>` reuses the run directory and short-circuits any leaf whose
content-key is in the prior run's `memo/` dir. The model is **not called** for
memoized leaves — they replay for free.

### How content keys work

Each step leaf's content key is a hash of `(kind, code-version, args, phase,
step-name, prompt, schema, effective-policy)`. Checkpoints use `(kind,
code-version, args, phase, key)`. Same inputs → same key → memo hit → no
re-call. An occurrence ordinal distinguishes identical repeats in source
order. Tightening or otherwise changing the effective step policy invalidates
that step's memo.

### Automatic invalidation

Edit the workflow or change `--args` → content keys change → no memo hits →
full re-run. No guard files to maintain; the invalidation is automatic.

### Per-leaf granularity

Delete one memo file → that leaf re-runs while others still replay. A missing
memo always re-runs conservatively (never resumes wrong).

### Resume segment

A `--resume` run writes a fresh `events.resume-N.jsonl` segment (not
appended to `events.jsonl`) so each file keeps the frozen invariants (first
line is `run.started`, `seq` monotonic from 0). The viewer merges segments.

### Resume doesn't double-charge

A `--resume` run starts spend at zero. Memoized leaves don't re-call the
model and don't recharge the budget. Only leaves that actually run count
against the cap.

## Budget enforcement

Declare `:budget {:tokens N :usd M}` in the `defworkflow` metadata. The
runtime charges each step leaf and latches a sticky `over_budget` flag when
a cap is exceeded — further step leaves are **refused** and the run ends
`{:status :failed :reason "budget exceeded"}`.

```sema
(defworkflow audit
  "Audit with a 5000-token cap."
  {:phases ["Scan" "Report"]
   :budget {:tokens 5000}}

  (phase "Scan")
  (def a (step "Find files." {}))
  ;; a burns 5200 tokens → cap trips after its Budget event

  (phase "Report")
  (def b (step "Summarize." {}))
  ;; b refused: over_budget latch is sticky

  {:status :success :a a :b b})
;; → {:status :failed :reason "budget exceeded"}
```

- **Token caps are deterministic.** `:tokens N` counts actual usage tokens.
- **USD caps are best-effort.** `:usd M` depends on the pricing table being
  available for the model.
- **Per-leaf attribution.** Each `budget` event records the `agent_id`, token
  counts, and cost — the dashboard shows per-leaf spend.
- **Sticky latch.** Once tripped, the latch stays set for the rest of the run.
  No step leaf launches after it, even under concurrent `parallel` fan-out.

## Permission enforcement

Declare `:permissions` in the `defworkflow` metadata to tighten the sandbox
for `sema workflow run`. The value uses the same syntax as the CLI
`--sandbox` flag: `"strict"`, `"all"`, `"none"`, or comma-separated
capabilities such as `"no-fs-write,no-network"`. Capability names may be
written with or without the `no-` prefix (`"fs-write"` and `"no-fs-write"`
are equivalent), but workflow docs use the `no-*` form because it reads as a
denial list.

| Value | Denies |
|-------|--------|
| `none` | Nothing; useful only when you want the metadata to say there is no workflow-specific tightening |
| `strict` | `shell`, `fs-write`, `network`, `env-write`, `process`, `llm`, `serial` |
| `all` | Every capability listed below |
| `no-fs-read` | File, directory, import, PDF, stream-input, `http/file`, and read-side DB access |
| `no-fs-write` | File writes/deletes/renames, output streams, KV writes, and write-side DB access |
| `no-shell` | Calls to `shell` |
| `no-network` | HTTP client/server operations |
| `no-env-read` | Environment and host information reads |
| `no-env-write` | Environment variable writes |
| `no-process` | Process operations such as `exit`, `sys/args`, `sys/which`, and `shell` |
| `no-llm` | LLM calls |
| `no-serial` | Serial port operations |

```sema
(defworkflow readonly-audit
  "Audit without writing files or using the network."
  {:phases ["Audit"]
   :permissions "no-fs-write,no-network"}

  (phase "Audit")
  (def files (file/list "src"))
  {:status :success :files files})
```

Workflow permissions can only remove capabilities from the caller's sandbox;
they cannot loosen a stricter `--sandbox` or `--allowed-paths` setting.

## Model and tool policies

Policies constrain the resolved model and model-requested tool calls inside a
workflow. Define one with `defpolicy`, then attach it to a workflow:

```sema
(defpolicy safe-agent
  {:models
    {:default :deny
     :allow ["openai/gpt-5" "anthropic/*"]
     :deny ["anthropic/deprecated-model"]
     :on-deny :fail}

   :tools
    {:default :deny
     :allow
      {"read-file"   {:paths ["src/**" "Cargo.toml"]}
       "fetch-url"   {:domains {:allow ["api.example.com" "*.example.com"]
                                :schemes ["https"]
                                :ports [443]}}
       "run-command" {:commands ["cargo test" "cargo check"]}}
     :deny ["delete-file"]
     :on-deny :tool-error}})

(defworkflow guarded-audit
  "Audit with a least-privilege model and tool envelope."
  {:phases ["Audit"]
   :permissions "no-fs-write"
   :policy safe-agent}

  (phase "Audit")
  (def result
    (step "Inspect the Rust sources."
      {:name "auditor"
       :tools [read-file fetch-url run-command]}))
  {:status :success :result result})
```

Model rules use an exact `provider/model` identity. The only wildcard form is
`provider/*`; provider wildcards and partial model globs are rejected. Deny
rules win over allow rules. When `:models` or `:tools` is present,
`:default` defaults to `:deny`.

Tool allow entries may be unconstrained (`{}`) or constrain named JSON
arguments:

| Constraint | Shorthand argument | Match |
|------------|--------------------|-------|
| `:paths` | `"path"` | Workspace-relative literal, `*`, and `**` patterns; absolute paths and root/symlink escapes are denied |
| `:domains` | `"url"` | Parsed HTTP(S) URLs matched by normalized hostname, scheme, and optional effective port |
| `:commands` | `"command"` | Exact command strings only; no wildcard or shell-prefix matching |

A leading `*.` matches subdomains only, so list both `"example.com"` and
`"*.example.com"` when both the apex and its subdomains are allowed. URLs
containing credentials are always denied.

Use explicit selectors when a tool uses different argument names or has
multiple path-like arguments:

```sema
{:tools
 {:allow
  {"copy-file"
   {:paths [{:arg :source :allow ["src/**"]}
            {:arg :destination
             :allow ["generated/**"]
             :deny ["generated/private/**"]}]}}}}
```

### Composition and denial behavior

A step policy is combined with the workflow policy using logical AND: every
active layer must allow the boundary. A step may tighten its workflow but
cannot loosen it. The strictest denial action across active layers wins.
Step policies may contain model, tool, subject, input, and output controls.
Run-wide `:metadata` and `:completion` evidence requirements must be attached
to the workflow policy; `workflow check` and the runtime reject them on steps.

| Boundary | `:on-deny` | Behavior |
|----------|------------|----------|
| Model | `:fail` (default) | Fail before cache, cassette, callback, or provider access |
| Model | `:skip` | Skip a denied fallback target; a non-fallback call still fails |
| Tool | `:fail` (default) | Preflight the whole requested batch and run none when any call is denied |
| Tool | `:tool-error` | In an agent loop, return a correlated tool error for the denied call while allowed siblings run |

`:fail` raises a `:policy-denied` condition. Its message names the policy,
boundary, and denied subject. Catch the condition when code needs the exact
decision:

```sema
(try
  (llm/complete "Review this change.")
  (catch denial
    {:type (:type denial)         ; :policy-denied
     :policy (:policy denial)     ; "safe-agent"
     :boundary (:boundary denial) ; "model"
     :subject (:subject denial)
     :rule (:rule denial)
     :reason (:reason denial)
     :action (:action denial)     ; :fail
     :source (:source denial)}))  ; :request, :cache, or :cassette
```

For example, a denied model reports:
`Policy 'safe-agent' denied model 'openai/unlisted': model openai/unlisted is not allowlisted`.
Tool errors returned to a model contain only the tool name and safe denial
reason. They do not include an extra CLI `Error:` prefix.

The model gate covers completion, chat, extraction, classification, streaming,
fallbacks, embeddings, and reranking. The tool gate covers `ToolDefinition`
dispatch through agents and direct `tool/invoke`, including tools discovered
through MCP. Checks happen before cache/cassette replay and before user
callbacks, schema predicates, or tool handlers. Cache/cassette keys and resume
keys include the effective policy fingerprint; replay also rechecks the stored
provider identity.

`policy.checked`, `policy.violation`, and `policy.bypassed` events identify the
policy, boundary, matched rule, enforcement action, and whether the source was
a request, cache, or cassette. Tool arguments are represented only by a digest in
policy events; raw paths, URLs, and commands are not recorded there.

### First-party standard policy pack

The [`sema-policies`](https://github.com/sema-lisp/packages/tree/main/sema-policies)
package provides reusable least-privilege, content-safety, output-contract, and
workflow-evidence policies for Sema 1.34 or newer:

```bash
sema pkg add sema-policies
```

```sema
(import "sema-policies")

(define project-policy
  (list
    (policies/model-allowlist ["openai/gpt-5"])
    (policies/read-only-repository ["src/**" "Cargo.toml"])
    policies/no-sensitive-data-to-models))
```

The pack also includes tool allowlists, output contracts, a no-tools profile,
public-content controls, and evidence baselines for public-sector RAG and AI
documentation. These are deterministic runtime controls, not compliance
certifications. Policy lists compose as an intersection, so every layer must
allow an operation.

### Trusted lexical bypass

Trusted workflow code can bypass model/tool policy for a narrow lexical scope:

```sema
(policy/without "read the legacy migration fixture"
  (step "Inspect the fixture." {:tools [read-file]}))
```

The reason must be a non-empty literal string of at most 256 characters. The
bypass is task-local, applies only to its body, and emits `policy.bypassed` for
each protected boundary. It never bypasses the outer sandbox.

Policies govern LLM/model boundaries and model-invoked tools. Ordinary author
code such as direct filesystem, shell, HTTP, or raw MCP calls remains governed
by `:permissions`, the CLI sandbox, and allowed-path settings. Keep both:
policy controls what the model may choose; the sandbox remains the hard outer
capability ceiling.

## `sema workflow check`

Statically validate a workflow file **without evaluating it or calling any
LLM**. Catches arity traps, bad options, invalid literal policy maps,
`defpolicy` shape errors, unsafe matcher syntax, and invalid
`policy/without` reasons before you spend a token.

Policy diagnostics identify the invalid field or one-based list entry. Unknown
keys include a suggested replacement when one is close, or list the valid keys.
Invalid enum values list the accepted Sema keywords.

```bash
$ sema workflow check audit.sema
error[WF-PHASE-ARITY]: phase expects exactly 1 argument (a label), got 3
  at line 12, col 3
  hint: phase is a MARKER — use (phase "Audit") then body forms after it

$ sema workflow check audit.sema --strict  # treat warnings as errors
$ sema workflow check audit.sema --json    # machine-readable diagnostics
```

Checks fire **only inside a `defworkflow` body** — a bare `(parallel …)` in
an ordinary library file never trips a workflow-only diagnostic.

## `sema workflow view`

A web viewer that renders the run journal as a live tree. Phases nest agents;
budget events show per-leaf spend; checkpoints show their digests. It is
read-only unless it starts with a private approval authority that matches a
pending request.

```bash
# Open the viewer for a run directory
sema workflow view --run-dir .sema/runs --port 8899

# Enable approve/reject controls for one authority
sema workflow view \
  --run-dir .sema/runs \
  --approval-signing-key-file .sema/approval.private \
  --approval-actor release-manager

# Run a workflow and open the viewer simultaneously
sema workflow run my-workflow.sema --view

# Backfill the cross-run SQLite index (for offline/CI use)
sema workflow index --run-dir .sema/runs
```

The viewer is loopback-only by default. A viewer with an approval signing key
refuses a non-loopback bind. Each process creates a random page token and
requires it on every write request; this blocks blind cross-origin form posts,
but it is not remote-user authentication. A viewer without a signing key can
still bind elsewhere when the operator asks it to, which exposes run data and
the existing MCP authorization controls to that network.

Approve and reject forms use the same signed sidecar protocol and first-writer
wins rule as the CLI commands. Actor, optional approval comment, and required
rejection reason are stored in the signed decision. A successful decision does
not run workflow code in the viewer; resume the same run to apply it.

## Macro cookbook

The workflow DSL is homoiconic — agent patterns from the literature are
macros that expand into `parallel`, `pipeline`, and `step` forms. These are
from `examples/workflows/cookbook.sema` — load and use them inside any
`defworkflow` body.

### ReAct

Reason → act (tool) → observe, bounded rounds.

```sema
(defmacro react (question tools max-rounds)
  `(let loop ((round 1) (scratch ""))
     (let ((answer (step (str "Question: " ,question "\n\n"
                               "Reason step-by-step, call a tool when you "
                               "need a fact, then give the final answer.\n"
                               (if (= scratch "") ""
                                 (str "Notes so far:\n" scratch "\n")))
                        {:name "react" :tools ,tools})))
       (if (or (>= round ,max-rounds)
               (not (string/contains? (string/lower answer) "next:")))
         answer
         (loop (+ round 1) (str scratch "\n" answer))))))
```

### Reflexion

Attempt → self-critique → retry with critique, bounded.

```sema
(defmacro reflexion (task max-tries)
  `(let loop ((try 1) (note ""))
     (let ((attempt (step (str ,task
                                (if (= note "") ""
                                  (str "\n\nPrevious critique:\n" note)))
                       {:name "actor"})))
       (if (>= try ,max-tries)
         attempt
         (let ((critique (agent
           (str "Critique this attempt. If it is good, reply exactly "
                "\"OK\". Otherwise list concrete fixes.\n\n" attempt)
           {:name "critic"})))
           (if (string/starts-with? (string/trim critique) "OK")
             attempt
             (loop (+ try 1) critique)))))))
```

### Tree-of-Thought

Fan out N candidates in parallel, score, keep the best.

```sema
(defmacro tree-of-thought (prompt n scorer)
  `(let ((cands (filter (fn (c) (not (nil? c)))
                  (parallel
                    (map (fn (i)
                           (fn () (agent
                             (str ,prompt "\n(Give one distinct candidate, "
                                  "attempt #" i ".)")
                             {:name "thought"})))
                         (range ,n))))))
     (if (null? cands)
       nil
       (foldl (fn (best c)
                (if (> (,scorer c) (,scorer best)) c best))
              (first cands) (rest cands)))))
```

### Debate

Two personas argue R rounds, a judge decides.

```sema
(defmacro debate (topic persona-a persona-b rounds)
  `(let loop ((r 1) (transcript (str "TOPIC: " ,topic)))
     (let* ((arg-a (step (str "You are " ,persona-a ". Argue your side.\n\n"
                               transcript)
                          {:name ,persona-a}))
            (t1 (str transcript "\n\n" ,persona-a ": " arg-a))
            (arg-b (step (str "You are " ,persona-b ". Rebut.\n\n" t1)
                          {:name ,persona-b}))
            (t2 (str t1 "\n\n" ,persona-b ": " arg-b)))
       (if (>= r ,rounds)
         (step (str "You are the judge. Read the debate and declare a "
                     "winner with one sentence of reasoning.\n\n" t2)
                {:name "judge"})
         (loop (+ r 1) t2)))))
```

## Examples

Two complete workflow examples are in `examples/workflows/`:

- **`content-pipeline.sema`** — a four-phase pipeline (Topics → Write →
  Verify → Publish) that generates short explainer articles. Uses `pipeline`
  fan-out with typed `step` leaves and a per-item verification gate.

- **`sema-docs-pipeline.sema`** — a six-phase pipeline (Topics → Draft →
  Review → Revise → Assemble → Publish) with journaled tool calls and a
  fan-in synthesis step. Exercises the full dashboard.

- **`cookbook.sema`** — the agent-pattern macros (ReAct, Reflexion,
  Tree-of-Thought, Debate). Load it, then use the macros inside any
  `defworkflow` body.

Run them:

```bash
export OPENAI_API_KEY=...
sema workflow run examples/workflows/content-pipeline.sema --view
```

## CLI reference

```bash
# Run a workflow file
sema workflow run <file> [--args <json>] [--run-dir <dir>] [--view] [--port <n>] [--resume <run-id>] [--approval-mode auto|prompt|pause|deny] [--approval-public-key-file <file>] [--approval-signing-key-file <file>] [--approval-actor <name>]

# Inspect or decide durable approval requests
sema workflow approval-keygen --private-key-file <file> --public-key-file <file>
sema workflow approvals <run-id> [--run-dir <dir>] [--json]
sema workflow approve <run-id> <approval-id> --signing-key-file <file> [--run-dir <dir>] [--actor <name>] [--comment <text>]
sema workflow reject <run-id> <approval-id> --signing-key-file <file> --reason <text> [--run-dir <dir>] [--actor <name>]

# Statically validate a workflow file
sema workflow check <file> [--strict] [--json]

# Backfill the cross-run SQLite index
sema workflow index [--run-dir <dir>]

# Open the web viewer; signing-key and actor enable loopback decision controls
sema workflow view [--run-dir <dir>] [--host <addr>] [--port <n>] [--approval-signing-key-file <file>] [--approval-actor <name>]
```

## Internal API

The builtins that back the DSL are registered in `sema-stdlib/src/workflow.rs`.
The macros (`defworkflow`, `defpolicy`, `policy/without`, `phase`, `step`,
`approval`) are in `sema-eval/src/prelude.rs`.
The runtime crate (`sema-workflow`) is a leaf — it depends only on
`sema-core` + `sema-otel` + serde, never on `sema-eval`.

| Builtin | Description |
|---------|-------------|
| `workflow/run` | Open a run scope, journal start/end, return `{:status …}` |
| `workflow/phase` | Marker — close the prior phase, open a new one |
| `workflow/step` | Run a leaf as a journaled step (started/result + budget) |
| `workflow/tool-call` | Journal a tool call by the current agent |
| `workflow/tool-result` | Journal a successful tool result by the current agent |
| `workflow/approval` | Create/read a durable approval request and decision |
| `workflow/policy-without` | Run a trusted thunk with an audited policy bypass |
| `checkpoint` | Record or read a keyed step value |
