---
name: "shell/quote"
module: "system"
section: "Shell & Process Control"
syntax: "(shell/quote s)"
returns: "string"
---

POSIX single-quote a string so it survives `sh -c` (the single-string form of
`shell`) as one literal word — no metacharacter is special inside single
quotes, so this defuses command injection. Wraps the value in single quotes and
rewrites each embedded `'` as `'\''`; the empty string becomes `''`.

```sema
(shell/quote "a b")            ; => "'a b'"
(shell/quote "a'b")            ; => "'a'\\''b'"
(shell/quote "")               ; => "''"

(shell (str "echo " (shell/quote "hi; rm -rf /")))
; => {:exit-code 0 :stdout "hi; rm -rf /\n" ...}  ; the payload is echoed, not run
```
