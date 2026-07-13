---
name: "term/supports-kitty-keys?"
module: "terminal"
section: "Raw-Mode Input"
---

Return `#t` if the terminal supports the kitty keyboard protocol. Sends the flags query (`CSI ?u`) followed by a Primary Device Attributes barrier and checks which reply arrives first (the kitty-spec-recommended detection). **Must be called in raw mode** (it reads the reply from stdin); returns `#f` when stdin is not a TTY or nothing replies within a short timeout.

```sema
(io/with-raw-mode
  (when (term/supports-kitty-keys?)
    (term/enable-kitty-keys!)))
```

Detection is unreliable inside tmux (kitty forwarding is off by default), so prefer letting the user force-enable when `$TMUX` is set.
