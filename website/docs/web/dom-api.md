# DOM API

The `dom/*` namespace provides a thin wrapper over the browser DOM API. All functions operate on **numeric handles** -- opaque IDs that reference DOM elements, text nodes, or events across the WASM boundary.

## Query

### `(dom/query selector)` -> handle | nil

Find the first element matching a CSS selector.

```sema
(def el (dom/query ".my-class"))
(def nav (dom/query "nav > ul"))
```

### `(dom/query-all selector)` -> list of handles

Find all elements matching a CSS selector.

```sema
(def items (dom/query-all "li.todo"))
```

### `(dom/get-id id)` -> handle | nil

Find an element by its `id` attribute.

```sema
(def app (dom/get-id "app"))
```

## Create

### `(dom/create-element tag)` -> handle

Create a new DOM element.

```sema
(def div (dom/create-element "div"))
```

### `(dom/create-text content)` -> handle

Create a text node.

```sema
(def txt (dom/create-text "Hello, world!"))
```

## Tree Manipulation

### `(dom/append-child! parent-handle child-handle)` -> child-handle

Append a child node to a parent element. Returns the child handle.

```sema
(def container (dom/get-id "app"))
(def p (dom/create-element "p"))
(dom/set-text! p "New paragraph")
(dom/append-child! container p)
```

### `(dom/remove-child! parent-handle child-handle)` -> child-handle

Remove a child node from its parent.

```sema
(dom/remove-child! container p)
```

### `(dom/remove! handle)` -> nil

Remove an element from the DOM entirely.

```sema
(dom/remove! (dom/query ".obsolete"))
```

## Attributes

### `(dom/set-attribute! handle attr value)` -> nil

```sema
(dom/set-attribute! el "data-count" "5")
```

### `(dom/get-attribute handle attr)` -> string | nil

```sema
(dom/get-attribute el "href")
```

### `(dom/remove-attribute! handle attr)` -> nil

```sema
(dom/remove-attribute! el "disabled")
```

## CSS Classes

### `(dom/add-class! handle class ...)` -> nil

Add one or more CSS classes.

```sema
(dom/add-class! el "active" "highlighted")
```

### `(dom/remove-class! handle class ...)` -> nil

Remove one or more CSS classes.

```sema
(dom/remove-class! el "active")
```

### `(dom/toggle-class! handle class)` -> boolean

Toggle a CSS class. Returns `true` if the class is now present, `false` otherwise.

```sema
(dom/toggle-class! el "expanded")
```

### `(dom/has-class? handle class)` -> boolean

Check whether an element has a CSS class.

```sema
(if (dom/has-class? el "active")
  (println "Element is active"))
```

## Styles

### `(dom/set-style! handle property value)` -> nil

Set a CSS style property. Use kebab-case property names.

```sema
(dom/set-style! el "background-color" "#f0f0f0")
(dom/set-style! el "font-size" "16px")
```

### `(dom/get-style handle property)` -> string

Get a CSS style property value.

```sema
(dom/get-style el "color")
```

## Content

### `(dom/set-text! handle text)` -> nil

Set the `textContent` of an element.

```sema
(dom/set-text! el "Updated content")
```

### `(dom/get-text handle)` -> string

Get the `textContent` of an element.

### `(dom/set-html! handle html)` -> nil

Set the `innerHTML` of an element. Use with caution -- no sanitization is performed.

```sema
(dom/set-html! el "<strong>Bold</strong>")
```

### `(dom/get-html handle)` -> string

Get the `innerHTML` of an element.

## Form Values

### `(dom/set-value! handle value)` -> nil

Set the `value` property of an input element.

```sema
(dom/set-value! input "default text")
```

### `(dom/get-value handle)` -> string

Get the `value` property of an input element.

```sema
(def text (dom/get-value input))
```

### `(dom/event-value event-handle)` -> string | nil

Read `event.target.value` from an event handle. Useful in input event handlers:

```sema
(define (on-input ev)
  (def val (dom/event-value ev))
  (println "Input:" val))
```

## Events

### `(dom/on! handle event callback)` -> nil

Add an event listener. The callback may be either:

- a function value
- a callback name string for an existing top-level function

The callback receives a numeric event handle as its argument.

```sema
(define (handle-click ev)
  (dom/prevent-default! ev)
  (println "Clicked!"))

(dom/on! btn "click" handle-click)
;; or:
(dom/on! btn "click" "handle-click")
```

The event handle is automatically released after the callback returns.

### `(dom/off! handle event callback)` -> nil

Remove a previously registered event listener.

```sema
(dom/off! btn "click" handle-click)
;; or:
(dom/off! btn "click" "handle-click")
```

### `(dom/prevent-default! event-handle)` -> nil

Call `preventDefault()` on an event.

```sema
(define (on-submit ev)
  (dom/prevent-default! ev)
  ;; handle form submission
  )
```

## SIP Rendering

### `(dom/render sip-data)` -> handle

Render a SIP vector into a DOM element and return its handle. See [SIP Markup](./sip-markup.md) for the format.

```sema
(def card (dom/render [:div {:class "card"} "Hello"]))
```

### `(dom/render-into! selector sip-data)` -> nil

Render SIP data into the element matching `selector`, replacing existing content.

```sema
(dom/render-into! "#app"
  [:div [:h1 "Hello, world!"]])
```

## Notes

- All handles are numeric IDs managed by an internal handle map. They reference DOM elements, text nodes, or events.
- `dom/on!` accepts either a function value or a callback-name string. `dom/off!` must be given the same callback identity that was used when registering the listener.
- When using `dom/on!` on elements inside a component rendered with morphdom, be aware that morphdom may replace DOM nodes, orphaning your listeners. Prefer SIP `on-*` attributes for components that re-render.
