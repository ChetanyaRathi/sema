---
name: "workflow/agent"
module: "workflow"
section: "Dynamic Workflows"
---

Run a leaf step (typically an LLM or tool call) as a journaled **agent**: `(workflow/agent label thunk)` emits an `agent.started` event before the thunk and an `agent.result` event after (with an opaque output digest + duration), so the workflow dashboard renders it as an agent row under the current phase. Returns the thunk's value, or propagates its error after journaling the result. Outside a `workflow/run` it is transparent — it just calls the thunk. Compose it inside `workflow/foreach` to make a fanned-out set of leaves show up as sibling agent rows.

```sema
(define (write-article topic)
  (workflow/agent topic
    (fn () {:title topic
            :body  (llm/complete (str "Explain " topic) {:model "gpt-5.4-mini"})})))

(workflow/foreach write-article topics 4)   ; N agent rows, <=4 at once
```

See also: `workflow/foreach`, `workflow/run`, `checkpoint`.
