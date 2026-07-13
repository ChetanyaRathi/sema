---
name: "term/query-secondary-da"
module: "terminal"
section: "Screen Control"
---

Request Secondary Device Attributes (`CSI >c`). The reply arrives through `io/read-key` as `{:kind :device-attributes :device :secondary :params (…)}`, whose params commonly encode the terminal's type id and version — a more reliable fingerprint than `$TERM` over SSH/tmux. Takes no arguments.
