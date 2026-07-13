---
name: "term/disable-bracketed-paste"
module: "terminal"
section: "Screen Control"
---

Disable bracketed paste mode (`CSI ?2004l`), undoing `term/enable-bracketed-paste`. Call on exit so paste markers don't leak into the shell afterward. Takes no arguments.
