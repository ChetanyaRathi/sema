# SIP Markup

SIP (Sema Interface Primitives) is a declarative format for describing DOM structures using Sema vectors. It follows the hiccup convention: each element is a vector of `[tag, attrs?, ...children]`.

## Format Overview

SIP vectors map directly to HTML elements:

| HTML | SIP |
|------|-----|
| `<div></div>` | `[:div]` |
| `<p>Hello</p>` | `[:p "Hello"]` |
| `<h1 class="title">Hello</h1>` | `[:h1 {:class "title"} "Hello"]` |
| `<a href="/about">About</a>` | `[:a {:href "/about"} "About"]` |
| `<input disabled />` | `[:input {:disabled true}]` |

The general shape is:

```sema
[:tag-name {:attr "value"} child1 child2 ...]
```

The attribute map is optional. When the second element is not a map, all remaining elements are treated as children.

## Tags

Tags are keywords. The leading colon is stripped during rendering:

```sema
[:div "content"]       ;; <div>content</div>
[:span "inline"]       ;; <span>inline</span>
[:button "Click me"]   ;; <button>Click me</button>
```

## Attributes

Attributes are a map in the second position. Keyword colons on keys are stripped automatically:

```sema
[:div {:id "main" :class "container" :data-count "5"}
  [:p "Hello"]]
```

Renders as: `<div id="main" class="container" data-count="5"><p>Hello</p></div>`

### Style Attribute

Style accepts either a string or a map of CSS properties:

```sema
;; String form
[:p {:style "color: red; font-size: 14px"} "Red text"]

;; Map form — property names are used as-is
[:p {:style {:color "red" :font-size "14px"}} "Red text"]
```

### Boolean Attributes

Boolean attributes are set or removed based on truthiness:

```sema
[:input {:disabled true}]   ;; <input disabled>
[:input {:disabled false}]  ;; <input>  (attribute removed)
[:input {:checked true}]    ;; sets the checked DOM property
```

### DOM Properties

`value`, `checked`, and `disabled` set the corresponding DOM properties directly rather than using `setAttribute`:

```sema
[:input {:type "text" :value "initial"}]
[:input {:type "checkbox" :checked true}]
```

## Event Handlers

Event handlers use `on-*` attributes. In SIP markup, the value must still be a **named function** string. The handler is installed as a delegated event via a `data-sema-on-*` attribute:

```sema
(define (handle-click ev)
  (println "clicked!"))

[:button {:on-click "handle-click"} "Click me"]
```

The event handler receives a numeric event handle as its argument. Use `dom/event-value` to read `event.target.value` from it, or `dom/prevent-default!` to cancel the default action.

> **Gotcha**: Inline lambdas are not supported as SIP event handler values. The value must be a string naming a defined function. Lower-level APIs like `dom/on!` can accept function values, but SIP delegated event attributes are still name-based.

### Event modifiers

An `on-*` attribute key can carry dotted modifiers, so the common wrappers do not need a line of handler code:

```sema
[:form {:on-submit.prevent "save"} ...]
[:button {:on-click.stop.once "buy"} "Buy"]
[:div {:on-click.self "close-modal"} ...]
[:div {:on-keydown.capture "intercept"} ...]
```

| Modifier | Effect |
| --- | --- |
| `.prevent` | `preventDefault()` **before** the handler runs, so the handler already sees `defaultPrevented` |
| `.stop` | `stopPropagation()` **after** the handler runs; delegated ancestors do not fire |
| `.once` | Runs at most once per element instance |
| `.capture` | Runs during the capture phase, so an ancestor sees the event before its descendants |
| `.self` | Runs only when the event target is the element itself, not a descendant |

Modifiers may be combined in any order (`.stop.prevent` and `.prevent.stop` are the same thing) and are applied in a fixed sequence: `.self` decides whether the handler runs at all, then `.prevent`, then the `.once` gate, then the handler, then `.stop`. A handler that `.self` filtered out does not prevent the default and does not use up its `.once`.

Details worth knowing:

- **`.prevent` outlives `.once`.** On the second dispatch of a `.prevent.once` handler the handler does not run, but the default is still prevented -- `.prevent` describes the element, not the invocation, and a navigation it failed to stop cannot be undone. `.stop` is the other way round: it only decides which *other* handlers see the event, so a spent `.once` releases it and delegated ancestors fire.
- `.once` is "once per element instance". If a re-render replaces the element -- a keyed list row that is discarded and rebuilt, for example -- the new element starts fresh.
- **`.once` needs a `:key` inside a list.** The spent mark belongs to the DOM element, and morphdom matches unkeyed siblings by position: reorder an unkeyed list and the element that carried the mark is handed to a different item, so the row the user clicked can fire again while a row they never touched is permanently dead. Give the rows a `:key`. In dev mode an unkeyed `.once` row among unkeyed siblings of the same tag is reported under `sip-render:once-without-key:<parent>`.
- `mouseenter` and `mouseleave` are synthesized from `mouseover`/`mouseout` and have no capture phase, so `.capture` is a no-op on those two. The handler still runs. Nesting works the way the real events do: every element the pointer entered runs its `mouseenter`, outermost first, and every element it left runs its `mouseleave`, innermost first -- an inner handler never swallows its ancestor's.

An unknown or empty modifier (`{:on-submit.prevnt "save"}`) is an error: the handler is **not** installed and the failure is reported through the app's `onerror` hook under `sip-render:on-handler`. A silently ignored typo would let a form navigate away with no signal at all.

The same applies to the **event name**. `on-*` attributes are routed by a delegated listener on the mount root, which listens for a fixed set of bubbling events ([the full list](/docs/web/components#supported-events)); anything else -- a typo like `{:on-sumbit.prevent "save"}`, a non-bubbling event like `focus`, or a custom element's own event -- is reported and not installed, with the nearest matching name or the delegable stand-in named in the message. Use `dom/on!` from an `on-mount` callback for events outside the set.

## Children

Children can be strings, numbers, booleans, `nil`, or nested SIP vectors:

```sema
[:div
  [:h1 "Title"]
  [:p "Paragraph " 42 " items"]
  [:p (if logged-in? "Welcome" "Please log in")]]
```

`nil` renders as an empty text node.

## Fragments

When the first element of an array is not a string (keyword), the array is treated as a fragment -- a list of sibling elements:

```sema
;; Returns two paragraphs as siblings
[[:p "First"] [:p "Second"]]
```

This is useful for returning multiple root elements from a function.

## Conditional Rendering

Use standard Sema conditionals -- they return SIP vectors:

```sema
(if loading?
  [:div {:class "spinner"} "Loading..."]
  [:div {:class "content"} "Ready"])
```

## List Rendering

Use `map` to produce lists of elements:

```sema
[:ul
  (map (fn [item] [:li (:text item)]) items)]
```

Since `map` returns a list (not a keyword-prefixed vector), the result is treated as a fragment and each element is appended.

### Keys

Give each row a `:key` when the list can reorder, grow, or shrink:

```sema
[:ul
  (map (fn [todo] [:li {:key (:id todo)} (:title todo)]) @todos)]
```

Without a key, re-renders match children **by position**. Reordering then rewrites every row in place, and anything the DOM was holding moves with the position rather than the item:

- focus jumps to a different row
- a half-typed `<input>` value lands on the wrong item
- scroll position, an open `<details>`, and in-flight CSS animations all shift

With a key, each row keeps its own DOM node across reorders, insertions, and removals.

Keys only need to be unique **among siblings** — the same key under two different parents is fine. They may be strings or numbers; numbers are compared as their string form.

If you are not sure whether you need one: a static list does not, a list driven by data does.

::: tip Duplicate keys
In [dev mode](/docs/web/diagnostics), duplicate sibling keys are reported through `onerror` and recorded in the timeline. The list still renders — but two rows claiming one key means the diff matches the same node twice, and DOM state migrates between them.
:::

Elements with an `id` get stable identity for free; an explicit `:key` takes precedence.

## Rendering Functions

### `sip/render`

Renders SIP data and returns an element handle (numeric ID):

```sema
(def el (sip/render [:div {:class "card"} "Hello"]))
(dom/append-child! parent el)
```

Non-element nodes (text, fragments) are wrapped in a `<span>`.

### `sip/render-into!`

Renders SIP data into a target element selected by CSS selector. Replaces existing content:

```sema
(sip/render-into! "#app"
  [:div
    [:h1 "My App"]
    [:p "Welcome"]])
```

### DOM Aliases

`dom/render` and `dom/render-into!` are identical to their `sip/` counterparts.

## Gotchas

- **Keyword colons are stripped** from both tag names and attribute keys. `:div` becomes `div`, `:class` becomes `class`.
- **SIP event handlers must be named functions** -- you cannot pass a lambda directly in `{:on-click ...}`. Define the function first, then reference it by name as a string.
- **`hiccup/render` and `hiccup/render-into!`** are legacy aliases for backward compatibility. Prefer the `sip/` or `dom/` namespace.
