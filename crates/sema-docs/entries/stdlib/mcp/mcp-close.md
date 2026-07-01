---
name: "mcp/close"
module: "mcp"
section: "MCP Client"
params: [{ name: handle, type: string, doc: "connection handle from mcp/connect" }]
returns: "nil"
---

```
(mcp/close handle)
```

Close an MCP connection. For a stdio server this terminates the child process;
for an HTTP server it best-effort ends the session (`DELETE`). After closing, the
handle is no longer valid. Dropping a handle without calling `mcp/close` still
tears down a stdio child, but calling it explicitly is clearer and deterministic.

```sema
(define fs (mcp/connect {:command "npx" :args ["-y" "server-filesystem" "/tmp"]}))
;; … use it …
(mcp/close fs)
```
