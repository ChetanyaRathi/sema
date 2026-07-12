---
name: "pty/wait"
module: "pty"
section: "Pseudo-Terminals"
---

Block until the child exits and return its exit code. All output is buffered first, so a following `pty/read` returns the tail.

Calling `pty/wait` again on the same handle while the first call is still in flight (e.g. two `async/spawn` tasks waiting on the same child) queues rather than racing it — both calls resolve to the same exit code once it exits. Every other `pty/*` op on a handle that's mid-wait errors clearly instead of racing it.
