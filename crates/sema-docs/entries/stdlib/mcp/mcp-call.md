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

```sema
(define fs (mcp/connect {:command "npx"
                         :args ["-y" "@modelcontextprotocol/server-filesystem" "/tmp"]}))

(mcp/call fs "read_file" {:path "/tmp/notes.txt"})
; => "…file contents…"
```

For agent use, prefer `mcp/tools->sema` so the model drives the calls; use
`mcp/call` directly for scripted, non-agent access.
