---
name: "workflow/foreach"
module: "workflow"
section: "Dynamic Workflows"
syntax: "(workflow/foreach f items n)"
---

Macro: the workflow fan-out combinator. Applies `f` to each of `items` with at most `n` running concurrently, returning results in **input order** — like [`async/pool-map`](/docs/stdlib/async/pool-map), but a failing item does **not** abort the batch. Each item's error is caught and surfaces as a `{:status :failed :error "…"}` map in that slot, so a later `verify` phase can branch on it (`async/pool-map` re-raises, killing the whole batch on the first failure — wrong for a fan-out where leaves may fail independently). Successful items return `f`'s value unchanged. Bounded concurrency is enforced by a capacity-`n` semaphore channel.

```sema
;; generate articles for many topics, <=4 model calls in flight, in order
(workflow/foreach write-article topics 4)

;; a failing item is tagged, not fatal:
(workflow/foreach (fn (i) (if (= i 1) (throw "boom") (* i 10))) (list 0 1 2) 2)
;; => (0 {:status :failed :error "boom"} 20)
```

See also: `defworkflow`, `workflow/agent`, `async/pool-map`.
