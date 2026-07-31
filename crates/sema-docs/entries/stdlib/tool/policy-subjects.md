---
name: "tool/policy-subjects"
module: "tool"
params: [{ name: tool, type: tool }]
returns: "vector"
---

Return the semantic policy subjects declared by a tool definition.

Each subject is a map with a `:kind`. File subjects include `:path-arg`,
network subjects include `:url-arg` and optional `:method`, command subjects
include `:command-arg`, and external-action subjects include `:action` and an
optional `:target-arg`.

```sema
(deftool read-source
  "Read a source file."
  {:path {:type :string}}
  {:policy-subjects [{:kind :file-read :path-arg :path}]}
  (fn (path) (file/read path)))

(tool/policy-subjects read-source)
; => [{:kind :file-read :path-arg :path}]
```

See also: `deftool`, `tool/name`, `tool/parameters`, `defpolicy`.
