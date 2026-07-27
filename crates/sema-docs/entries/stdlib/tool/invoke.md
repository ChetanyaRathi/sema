---
name: "tool/invoke"
module: "tool"
params: [{ name: tool, type: tool }, { name: args, type: map }]
returns: "any"
---

Invoke a tool definition's handler directly, without routing through an LLM
agent. Arguments are validated against the tool's parameter schema
(`tool/parameters`) and mapped to the handler's declared parameter order, then
the handler's raw return value is passed through unchanged (not stringified for
an LLM).

Argument values are JSON-coerced exactly as agent-driven tool calls: keywords
become strings, and values with no JSON representation are converted lossily.
This keeps a direct invocation byte-for-byte identical to what the handler
would receive from a model.

```sema
(deftool add-numbers "Add two numbers"
  {:a {:type :number} :b {:type :number}}
  (lambda (a b) (+ a b)))

(tool/invoke add-numbers {:a 2 :b 3})   ; => 5
(tool/invoke add-numbers {})            ; error: invalid arguments for tool 'add-numbers'
```
