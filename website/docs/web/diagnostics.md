# Diagnostics & Dev Mode

Sema Web catches failures rather than letting them take the page down — a
component that throws leaves the previous DOM in place, a broken event handler
does not break the next one. That is the right default, but it means failures
are quiet by default too. This page is how you hear them.

There are two mechanisms, and they compose:

- **`onerror`** — one hook that receives every caught failure. Use it in
  production to forward errors to your reporter.
- **`dev`** — a bounded in-memory timeline of what the runtime did. Use it in
  development to see renders, routes, streams, and script loads alongside the
  errors.

## The error hook

```js
const web = await SemaWeb.create({
  onerror(error, context) {
    reportToSentry(error, { tags: { context } });
  },
});
```

`context` is a short string naming where the failure came from:

| Context | Meaning |
| --- | --- |
| `component:todo-list` | the component function threw while rendering |
| `component-dispose:todo-list` | its render effect threw during teardown |
| `unmount-cleanup:todo-list` | an `on-mount` cleanup threw |
| `listener-cleanup:click` | removing a DOM listener threw |
| `event-source-cleanup` | closing an SSE stream threw |
| `inline-script:2` | the third inline `<script type="text/sema">` failed |
| `script:/app.sema` | an external script failed |

Installing a handler replaces the default (which logs to `console.error`). It
does **not** turn off the dev timeline: entries are recorded first, then your
handler runs, so a production reporter and a local timeline never fight.

## Dev mode

```js
const web = await SemaWeb.create({ dev: true });
```

That enables a bounded ring of events, readable through `web.diagnostics`:

```js
web.diagnostics.all();            // every retained entry, oldest first
web.diagnostics.byKind("error");  // just the failures
web.diagnostics.byKind("route");  // navigation history
web.diagnostics.slowRenders();    // renders at/over the threshold
web.diagnostics.dropped;          // how many entries the bound evicted
web.diagnostics.clear();          // start a fresh timeline
```

Each entry is `{ kind, at, context, detail?, durationMs? }`.

### What gets recorded

| Kind | Recorded when | `detail` |
| --- | --- | --- |
| `error` | any failure reaching the error hook | the error message |
| `render` | a component finishes rendering | — (carries `durationMs`) |
| `route` | the route changes | `/todos/42 -> todo-detail`, or `-> (no match)` |
| `stream` | an SSE or LLM stream opens or closes | `open` / `close` |
| `script` | a Sema script loads, evaluates, or fails | `evaluated`, or the error |

### Finding slow components

`render` entries carry a wall-clock duration covering the whole render — the
Sema call, SIP construction, and the DOM patch:

```js
const web = await SemaWeb.create({ dev: { slowRenderMs: 8 } });

// ... interact with the app ...

for (const r of web.diagnostics.slowRenders()) {
  console.log(r.context, r.durationMs.toFixed(1) + "ms");
}
// component:todo-list 24.3ms
```

The default threshold is 16ms — one frame at 60fps.

### Tuning

```js
await SemaWeb.create({
  dev: {
    limit: 500,        // ring size (default: 100)
    slowRenderMs: 8,   // slow-render threshold (default: 16)
    overlay: true,     // on-page dev panel (default: false)
  },
});
```

The ring is **bounded on purpose**. A component stuck in a render loop is
exactly the bug you want the timeline for, and an unbounded buffer would take
the tab down before you could read it. `dropped` tells you how many entries
fell off the back.

## The overlay

`dev: { overlay: true }` mounts a small fixed panel in the bottom-right corner
that tails the timeline — colour-coded by kind, newest last, with render
durations inline. It is click-through (`pointer-events: none`), so it never
steals input from the app underneath.

The overlay is loaded by a dynamic `import()`. In the ESM build that makes it a
separate chunk your production bundle never fetches; enabling it is the only
thing that pulls it in.

## Cost when disabled

Dev mode is off by default and costs nothing when off. Entries are built
lazily — with `dev` unset, no entry object is allocated and no `detail` string
is interpolated on the render path. Instrumentation you can leave in the
codebase is instrumentation that is still there when you need it.

## Teardown

`web.dispose()` removes the overlay and drops every diagnostics subscriber, so
nothing holds a reference to detached DOM. Recorded entries survive disposal —
reading the timeline after teardown is usually exactly when you want it.
