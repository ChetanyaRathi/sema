---
outline: [2, 3]
---

# Agent Memory

A memory thread is a persistent, append-only conversation log with a name. Where a [conversation](/docs/llm/conversations) is an immutable in-memory value you pass around, a memory thread is a durable resource: it lives in a registry keyed on `(:namespace, :id)`, writes every turn to a JSONL sidecar under `./.sema/memory/`, and survives process restarts. Open the same thread tomorrow and the turns are still there.

```sema
(define mem (memory/open {:id "user-42" :namespace "support"}))

(memory/append mem {:role "user" :content "My invoice is wrong."})
(memory/append mem {:role "assistant" :content "Looking into it now."})

;; …next session, next process:
(define mem (memory/open {:id "user-42" :namespace "support"}))
(conversation/messages (memory/messages mem))  ; both turns are back
```

::: tip
`memory/open` and `memory/append` require filesystem write capability (`FS_WRITE`) — a thread is a read-write resource. `memory/messages` is a pure in-memory read.
:::

## Functions

### `memory/open`

Open (or return) the thread for `(:namespace, :id)`. Idempotent within a process: reopening an open thread returns the same working set. A fresh open loads any prior turns from disk. Returns a handle map that the other `memory/*` functions accept.

```sema
(memory/open {:id "chat-1"})                      ; namespace defaults to "default"
(memory/open {:id "user-42" :namespace "support"})
```

`:id` and `:namespace` must be plain names — they become file names under `./.sema/memory/<namespace>/<id>.jsonl`, so path separators are rejected.

### `memory/append`

Append one turn. The turn is immediately visible to `memory/messages` and durable on disk before the call resolves (inside async tasks the write happens off the scheduler, so sibling tasks keep running). Returns the handle, so calls chain.

```sema
(memory/append mem {:role "user" :content "Hello"})
(memory/append mem {:content "role defaults to user"})
```

### `memory/messages`

Snapshot the thread into a regular [conversation](/docs/llm/conversations) value — everything that works on conversations (filtering, `llm/chat`, forking) works on the result.

```sema
(define conv (memory/messages mem))
(llm/chat conv {:model "claude-haiku-4-5-20251001"})
```

## Agents with memory

Pass a handle as `:memory` in [`agent/run`](/docs/llm/tools-agents) opts and the loop uses the thread as its history:

- **Seeding** — the thread's turns are sent ahead of the new user input.
- **Writeback** — after the run, the user input and the assistant's text replies are appended to the thread. Tool-protocol traffic is not recorded: the thread stays a clean text transcript that is always valid to re-seed.
- **Cancellation-safe** — if a run spawned with `async/spawn` is cancelled mid-conversation, the turns it had produced are still written back, so an interrupted session is not lost.

```sema
(defagent support-bot
  {:system "You are a support agent." :model "claude-haiku-4-5-20251001"})

(define mem (memory/open {:id "ticket-981" :namespace "support"}))

(agent/run support-bot "My invoice is wrong." {:memory mem})
;; …later, even in a new process — the bot remembers the ticket:
(agent/run support-bot "Any update?" {:memory mem})
```
