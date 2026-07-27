---
name: "match*"
module: "special-forms"
syntax: "(match* expr [pattern body ...] [pattern when guard body ...] ...)"
---

Pattern-match a value against a series of clauses, returning `nil` when no clause matches. `match*` is the permissive sibling of `match`: the two share identical pattern syntax, guards, and binding semantics, and differ only in what happens when nothing matches — `match` raises `match: no clause matched`, while `match*` yields `nil`.

Reach for `match*` when a non-match is an ordinary outcome you intend to test for, rather than a bug. It replaces the boilerplate catch-all clause `(_ nil)` and pairs naturally with `if`, `when`, and the nil-safe threading macro `some->`. Prefer `match` when every case should be covered, so an unhandled value surfaces as an error instead of silently becoming `nil`.

```sema
(match* 5 (1 :one) (2 :two))   ; => nil
(match* 5 (5 :five))           ; => :five
```

Patterns can be literals, vectors (matching lists or vectors by structure), maps (matching by keys), or binding patterns that capture the matched value; `_` matches anything without binding. Guards use `when`:

```sema
(match* n
  (x when (> x 100) :big)
  (x when (> x 0)   :small))
;; => nil for zero and negative n, rather than an error
```

Because a miss is `nil`, the result composes directly with conditionals:

```sema
(if-let (kind (match* event
                ({:type :click} :pointer)
                ({:type :key}   :keyboard)))
  (handle kind)
  (println "unrecognized event"))
```

**Note:** `match*` lowers through the same path as `match` (nested `if`/`let*` chains over the `__vm-try-match` helper), with the no-match branch producing `nil` instead of raising.
