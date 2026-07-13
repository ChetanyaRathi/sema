---
name: "term/query-kitty-keys"
module: "terminal"
section: "Screen Control"
---

Query the terminal's active kitty keyboard protocol flags (`CSI ?u`). The reply arrives asynchronously through `io/read-key` as `{:kind :kitty-flags :flags N}`; a terminal without kitty support sends nothing. For a synchronous yes/no answer, use `term/supports-kitty-keys?` instead. Takes no arguments.
