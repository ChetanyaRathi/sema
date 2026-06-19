---
name: "async/sleep"
module: "concurrency"
section: "Promises"
---

```sema
(async/sleep ms)
```

Inside an async task, yield for `ms` milliseconds on the scheduler's virtual clock. The clock only advances when every task is blocked, jumping to the nearest deadline, so a shorter sleep always wakes before a longer one, deterministically. On native the scheduler also waits the real time when it advances; in the browser playground the virtual clock advances instantly (the UI thread must not block), so durations still order tasks but no real time passes. Outside async, calls `thread::sleep` on native. Durations are capped at `86_400_000` ms (1 day).
