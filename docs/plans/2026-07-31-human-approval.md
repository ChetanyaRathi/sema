# Durable human approval for workflows

**Status:** Phases 1 and 2 implemented — 2026-07-31. Phase 3 is deferred.

## Goal

Add a host-controlled approval gate that can stop a workflow before a sensitive
action, record an operator decision durably, and resume the same run without
repeating completed leaves. Terminal and web clients must use the same request
and decision protocol; neither client is the authority.

```sema
(approval :release-signoff
  {:reason "Publish the package to the public registry"
   :subject {:kind :external-action :target "pkg.sema-lang.com"}
   :preview "Publish sema-policies@1.0.0"})
```

## Invariants

1. A pending approval stops evaluation before later workflow forms run.
2. Sema code cannot catch or forge the stop signal. Only `workflow/run`
   translates it into a `:needs-approval` result.
3. The request is durable before `approval.requested` and `run.ended` are
   reported. The journal is evidence, not the decision authority.
4. A decision is Ed25519-signed by a host-selected authority and bound to the
   exact request digest and revision. Changed entry/import/package code,
   arguments, phase, gate key, occurrence, subject, timestamp, or authority
   invalidates the decision.
   Evaluation uses the exact hashed dependency bytes and rejects imports or
   loads outside the preflight closure.
5. Decision creation is compare-and-set: the first approve/reject wins. A
   conflicting later decision fails without overwriting evidence.
6. Terminal EOF or Ctrl-C leaves a request pending. It is not a rejection.
7. Non-interactive and machine-readable runs never prompt implicitly.

## Run-directory protocol

Each run owns private approval sidecars:

```text
.sema/runs/<run-id>/approvals/
  <approval-id>.request.json
  <approval-id>.decision.json
```

The request binds the run id, workflow/code and argument fingerprints, phase,
gate key and occurrence, subject digest, reason, revision, and request digest.
The request stores only an optional operator-safe preview, not the raw subject.
The decision binds the request digest and revision and records approve/reject,
actor, provenance, optional comment/reason, timestamp, and Ed25519 signature.
The request contains only the public authority key; the workflow process never
receives the matching private key.

Sidecars are written with private permissions and atomically published. A
decision file is never replaced.

## CLI

Phase 1 provides:

```text
sema workflow run FILE --approval-mode auto|prompt|pause|deny
sema workflow approval-keygen --private-key-file PRIVATE --public-key-file PUBLIC
sema workflow approvals RUN_ID
sema workflow approve RUN_ID APPROVAL_ID --signing-key-file PRIVATE [--comment TEXT]
sema workflow reject RUN_ID APPROVAL_ID --signing-key-file PRIVATE --reason TEXT
```

- `auto` prompts only when stdin and stderr are terminals and `CI` is unset;
  otherwise it behaves as `pause`.
- `prompt` requests an interactive approve/reject choice. It requires a TTY.
- `pause` requires `--approval-public-key-file PUBLIC` when a gate is reached,
  then returns exit code 3 with exact resolve/resume commands.
- `deny` records no decision and fails the run at the gate.
- An approval entered during `run` is stored first, then the CLI resumes the
  same run id. Existing checkpoint and agent memos prevent completed leaves
  from running again.

## Workflow outcomes and events

The workflow envelope uses `:needs-approval` for a pending request and
`:rejected` for an explicit rejection. The CLI uses exit code 3 for pending and
exit code 1 for rejected/failed.

Additive journal events are:

- `approval.requested`
- `approval.granted`
- `approval.rejected`
- `approval.applied`

`approval.granted`/`approval.rejected` describe the durable decision observed
on resume. `approval.applied` records that execution crossed an approved gate.

## Phases

### Phase 1 — explicit workflow gate and terminal client

- Durable request/decision store with race, tamper, and idempotency tests.
- `approval` macro and `workflow/approval` builtin.
- Uncatchable workflow approval control signal.
- `:needs-approval`/`:rejected` envelopes and approval events.
- Terminal prompt plus list/approve/reject commands.
- Static checker, CLI integration tests, and user documentation.
- Host-owned immutable run configuration, signed decisions, canonical subjects,
  and full static dependency-closure binding.
- Approval gates are sequential. Gates nested in concurrency, cleanup/retry,
  steps, or nested workflows are rejected before execution.
- Durable approval sidecars use Unix permission modes or protected Windows
  ACLs. Other targets fail closed when private files cannot be enforced.

### Phase 2 — web client

- The viewer projects validated approval sidecars into request and decision
  summaries without exposing keys, signatures, or code digests.
- A matching host-held private key enables approve/reject controls. Missing or
  mismatched authority keeps the request inspect-only.
- Approval-enabled viewers refuse non-loopback binds. The existing per-process
  page token is required on decision writes to block blind browser posts.
- Decisions use the CLI compare-and-set protocol. A lost race displays the
  durable winning decision.
- The viewer records a decision only. The operator resumes the exact run to
  apply it.

### Phase 3 — automatic policy/tool gates

- Allow policy rules to return `require-approval` at model/tool boundaries.
- Persist serializable agent/tool-loop continuation state before stopping.
- Bind requests to policy digest, rule, tool name, and canonical arguments.
- Resume immediately before the protected call and re-check expiry and request
  bindings.

This phase is separate because the current agent loop carries thread-local and
in-memory continuation state. Explicit workflow gates are safe with the existing
deterministic workflow replay and memo protocol.

## Acceptance checks

- A fresh run stops at a gate, writes one valid request, and does not execute a
  following side effect.
- Approval followed by resume crosses the gate and completes the run.
- Rejection followed by resume ends as rejected and does not cross the gate.
- A surrounding Sema `try`/`catch` cannot bypass a pending or rejected gate.
- A gate placed inside `parallel`/`pipeline`/`async/spawn` is rejected before
  execution; place the gate before the concurrent work.
- Two racing decisions produce exactly one durable winner.
- CLI and loopback web decisions produce the same signed sidecar shape.
- A viewer without the matching authority cannot decide a request.
- A decision copied from another request, revision, or run is rejected.
- `auto` never prompts in CI or without terminal input/output.
