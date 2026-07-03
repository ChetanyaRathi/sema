---
name: "mcp/tools"
module: "mcp"
section: "MCP Client"
params: [{ name: handle, type: string, doc: "connection handle from mcp/connect" }]
returns: "list"
---

```
(mcp/tools handle)
```

List the tools an MCP server exposes (`tools/list`). Returns a list of maps, one
per tool, each with `:name`, `:description`, and `:input-schema` (the tool's raw
JSON-Schema for its arguments).

To feed these tools to an agent, use `mcp/tools->sema` instead — it produces the
value shape `deftool`/`defagent` expect.

```sema
(define fs (mcp/connect {:command "npx"
                         :args ["-y" "@modelcontextprotocol/server-filesystem" "/tmp"]}))

(mcp/tools fs)
; => ({:name "read_file" :description "Read a file" :input-schema {…}} …)

;; Just the names:
(map (fn (t) (:name t)) (mcp/tools fs))
```
