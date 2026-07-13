---
name: "term/enable-focus-events"
module: "terminal"
section: "Screen Control"
---

Enable focus reporting (`CSI ?1004h`). The terminal then sends an event when the window gains or loses focus, which `io/read-key` decodes as `{:kind :focus :focused #t|#f}` — useful to pause a spinner or repaint when the user tabs away. Pair with `term/disable-focus-events`, or use the `term/with-focus-events` guard. Support is inconsistent (e.g. macOS Terminal.app); treat it as a nice-to-have. Takes no arguments.
