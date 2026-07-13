---
name: "term/query-primary-da"
module: "terminal"
section: "Screen Control"
---

Request Primary Device Attributes (`CSI c`). The reply arrives through `io/read-key` as `{:kind :device-attributes :device :primary :params (…)}` — a rough "what kind of terminal is this" capability list. Takes no arguments.
