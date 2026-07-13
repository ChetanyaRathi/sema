---
name: "term/query-cursor-position"
module: "terminal"
section: "Screen Control"
---

Request a cursor-position report (DSR, `CSI 6n`) and arm the reply decoder. The reply arrives through `io/read-key` as `{:kind :cpr :row R :col C}` (1-based). Arming matters: a `CSI…R` is otherwise byte-identical to modified-F3 (`CSI 1;<mod>R`), so `io/read-key` only reports `:cpr` when a query is outstanding. For a synchronous result, use `term/cursor-position`. Takes no arguments.
