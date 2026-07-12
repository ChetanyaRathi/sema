---
name: "stream/copy"
module: "streams"
section: "Control"
---

Copy all bytes from a readable stream to a writable one, streaming through an internal buffer (no need to hold the whole payload in memory). Returns the total bytes copied.

When BOTH streams are file-backed, `stream/copy` runs its ordinary synchronous loop even inside `async/spawn` — a narrow, documented exception (avoids a two-resource checkout that could deadlock against a concurrent reverse copy). A copy with only one file-backed side (the other in-memory or stdio) offloads normally and doesn't stall siblings.

```sema
;; Stream a file to another file without loading it fully
(with-stream (in (stream/open-input "src.bin"))
  (with-stream (out (stream/open-output "dst.bin"))
    (stream/copy in out)))   ;; => bytes copied

;; Drain a string source into an in-memory buffer
(let ((in (stream/from-string "hello"))
      (out (stream/byte-buffer)))
  (stream/copy in out))      ;; => 5
```
