---
name: "mcp/call"
module: "mcp"
section: "MCP Client"
params: [{ name: handle, type: string }, { name: tool, type: string, doc: "tool name" }, { name: args, type: map, doc: "arguments object" }]
returns: "any"
---

```
(mcp/call handle tool args)
```

Invoke a tool on an MCP server (`tools/call`) and return its result normalized to
a Sema value: a plain text result collapses to a string; a richer result (images,
resources, `structuredContent`) is returned as the full map. A tool that reports
`isError` surfaces as a `SemaError`.

Inside `async/spawn`, `mcp/call` offloads the round trip and yields so sibling
tasks keep running. A connection handles one call at a time (MCP is a single
JSON-RPC pipe): concurrent calls on the *same* handle queue and run in turn;
calls on different handles overlap freely. Cancelling a call in flight
(`async/timeout`/`async/cancel`) drops the connection — any later call on that
handle errors with a reconnect hint; reconnect with `mcp/connect` to continue.

```sema
(define fs (mcp/connect {:command "npx"
                         :args ["-y" "@modelcontextprotocol/server-filesystem" "/tmp"]}))

(mcp/call fs "read_file" {:path "/tmp/notes.txt"})
; => "…file contents…"
```

For agent use, prefer `mcp/tools->sema` so the model drives the calls; use
`mcp/call` directly for scripted, non-agent access.
