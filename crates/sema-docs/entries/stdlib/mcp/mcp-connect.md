---
name: "mcp/connect"
module: "mcp"
section: "MCP Client"
params: [{ name: config, type: map, doc: "connection spec: :command (stdio) or :url (http)" }]
returns: "string"
---

```
(mcp/connect {:command "…" :args […] :env {…} :cwd "…"})
(mcp/connect {:url "https://…/mcp" :headers {…} :auth {:client-id "…"}})
```

Connect to an external MCP (Model Context Protocol) server and return an opaque
connection **handle** (a string) for use with `mcp/tools`, `mcp/call`,
`mcp/tools->sema`, and `mcp/close`. The handshake (`initialize`) runs eagerly, so
a returned handle is ready to use. The transport is chosen from the config map:

- **`:command`** — spawn a local server as a child process and speak JSON-RPC
  over stdio. Optional `:args` (list of strings), `:env` (map of extra
  environment variables — the place to pass a token a server reads from its
  environment), and `:cwd`. Requires the `process` sandbox capability.
- **`:url`** — connect to a remote server over **Streamable HTTP** (falls back
  automatically to the deprecated 2024-11-05 HTTP+SSE transport when a server
  only speaks that). Requires the `network` capability. Optional `:headers`
  attaches a static bearer token (`{"Authorization" "Bearer …"}`); `:auth
  {:client-id "…"}` supplies a pre-registered OAuth client id.

A remote server that requires OAuth is handled automatically: the first `401`
triggers the browser login flow (or a cached/refreshed token), then the handshake
retries. See `sema mcp login` to authenticate ahead of time.

Connecting to an MCP server runs its tools with the **server's** authority, not
Sema's sandbox — treat an untrusted server like untrusted code.

```sema
;; Local stdio server
(define fs (mcp/connect {:command "npx"
                         :args ["-y" "@modelcontextprotocol/server-filesystem" "/tmp"]}))

;; Remote server (OAuth handled automatically on first use)
(define asana (mcp/connect {:url "https://mcp.asana.com/mcp"}))

;; Remote server with a bring-your-own bearer token
(define gh (mcp/connect {:url "https://mcp.example.com/mcp"
                         :headers {"Authorization" "Bearer ghp_…"}}))
```
