---
name: "proc/wait"
module: "process"
section: "Processes"
---

Block until the process exits and return its exit code (`-1` if killed by a signal). Reader threads finish flushing first, so a subsequent `proc/read-stdout` returns the tail.

Calling `proc/wait` again on the same handle while the first call is still in flight (e.g. two `async/spawn` tasks waiting on the same process) queues rather than racing the child — both calls resolve to the same exit code once it exits. Every other `proc/*` op on a handle that's mid-wait errors clearly instead of racing it.
