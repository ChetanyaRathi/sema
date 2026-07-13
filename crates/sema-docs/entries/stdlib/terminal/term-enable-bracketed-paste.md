---
name: "term/enable-bracketed-paste"
module: "terminal"
section: "Screen Control"
---

Enable bracketed paste mode (`CSI ?2004h`). The terminal then wraps pasted text in markers, so `io/read-key` returns a whole paste as `{:kind :paste :text "…"}` instead of interpreting its newlines and control bytes as live keystrokes (a real injection vector otherwise). Pair with `term/disable-bracketed-paste`, or use the `term/with-bracketed-paste` guard to disable automatically on exit. Takes no arguments.
