---
name: "mcp/tools->sema"
module: "mcp"
section: "MCP Client"
params: [{ name: handle, type: string, doc: "connection handle from mcp/connect" }]
returns: "list"
---

```
(mcp/tools->sema handle)
```

Convert an MCP server's tools into the exact value shape `deftool` produces
(name, description, params map, handler), so `defagent` can consume external MCP
tools as first-class agent tools with no agent-loop changes. Each returned tool's
handler calls back into the server via the connection; a tool that reports
`isError` surfaces to the agent loop as an error it can react to.

The MCP `inputSchema` (JSON Schema) is inverted into the `{param-name -> spec}`
map the agent loop expects (type, description, enum, and `:optional` for
parameters not in the schema's `required` list).

```sema
(define fs (mcp/connect {:command "npx"
                         :args ["-y" "@modelcontextprotocol/server-filesystem" "/tmp"]}))

(defagent librarian
  {:model "claude-sonnet-5"
   :system "You manage files."
   :tools (mcp/tools->sema fs)})     ; MCP tools become agent tools

(agent/run librarian "Summarize /tmp/notes.txt")
```
