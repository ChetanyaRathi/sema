# Async Resources

A resource wraps one HTTP request in a reactive signal, so a component can
render loading, error, and success from a single dereference and never touch a
promise.

```sema
(defcomponent user-card (props)
  (def u (resource "user" (fn () (string-append "/api/users/" (:id props)))))

  (cond
    ((:loading @u) [:p "Loading..."])
    ((:error @u)   [:p {:class "error"} (:error @u)])
    (else          [:h2 (:name (:value @u))])))
```

## `(resource "name" spec-fn)` -> handle

Creates — or reuses — a named resource and returns a numeric handle. The first
attempt starts immediately, on a clean stack: `spec-fn` is never called during
the render that created the resource.

`spec-fn` **describes** the request, it does not perform it. It takes no
arguments and returns either a URL string or an options map:

```sema
;; A bare URL is a GET
(resource "user" (fn () "/api/users/7"))

;; An options map is anything else
(resource "search"
  (fn ()
    {:url "/api/search"
     :method :post
     :headers {"x-token" @token}
     :body {:q @query}
     :with-credentials true
     :as :json}))
```

| Key                 | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `:url`              | Required. Request URL.                                         |
| `:method`           | Defaults to `GET`, or `POST` when a `:body` is present.        |
| `:headers`          | Map of header name to value; values are stringified.           |
| `:body`             | A string is sent as-is; anything else is JSON-encoded and gets a JSON content type. |
| `:with-credentials` | `true` sends cookies cross-origin (`credentials: "include"`).  |
| `:as`               | `:auto` (default, follows the content type), `:json`, or `:text`. |

::: tip Why the spec returns a request instead of making one
The obvious API — `(resource (fn () (http/get "/api/users")))` — cannot work in
the browser. Every `http/*` native rejects outside an async evaluation root, and
a Sema callback invoked from JavaScript is always the synchronous path. So the
callback describes the request and the runtime performs it.
:::

## Resource State

Dereferencing the handle gives a map:

```sema
{:loading false     ;; true from creation, and again during every refetch
 :value {:name "Ada"}  ;; the most recent successful body, or nil
 :error nil         ;; failure message of the most recent attempt, or nil
 :status 200}       ;; HTTP status of the most recent attempt, or nil
```

Two properties are worth relying on:

- **Revalidating never blanks the UI.** A refetch keeps `:value` and `:status`
  from the previous response while `:loading` is `true`, and a failure keeps the
  previous `:value` as well.
- **`:status` reports what the server said**, including when the body could not
  be decoded — a 200 carrying malformed JSON reports `:error` *and* `:status 200`,
  so a component can tell that apart from a transport failure (`:status nil`).

## Refetching

A resource refetches when the **request its spec resolves to** changes.

The spec is re-resolved once, on a clean stack, whenever the owning component
re-renders. If the resulting request differs from the one the current data came
from — URL, method, headers, body, credentials, or `:as` — a fresh attempt
starts, keeping the previous value on screen while it runs. If the request is
identical, nothing happens.

```sema
(def uid (state "1"))

(defcomponent user-card ()
  ;; Re-resolved on every render of this component. Changing `uid` re-renders
  ;; the view (it reads @uid), the URL moves, and the resource refetches.
  (def u (resource "user" (fn () (string-append "/api/users/" @uid))))

  [:div
   [:span @uid]
   [:span (if (:loading @u) "..." (:name (:value @u)))]])
```

The comparison is on the request, never on the closure: a component body
allocates a new closure every render, so refetching on a new closure would fetch
forever — the response writes the signal, and the write re-renders.

::: warning Inputs the view never reads
The check is driven by re-renders. A spec that reads state the view does not
read has nothing to trigger it, because nothing re-renders the component. Either
read the value in the view, or refresh explicitly:

```sema
(effect (list @uid) (fn () (resource/refresh! "user")))
```
:::

Keep the spec a pure function of its inputs. It is called again on every render
that could have changed the request, and once more per refetch — so a spec with
side effects repeats them, and one that builds a *different* request every call
(a cache-busting timestamp, a random id) refetches on every render by
definition. When you want a fresh response from an unchanged URL, ask for one
with `resource/refresh!` instead of varying the URL.

## `(resource/refresh! handle-or-name)`

Starts a fresh attempt at the current spec, keeping the value and status on
screen while it runs. Use it for a "reload" button, a poll, or after a mutation.

```sema
(defcomponent user-card ()
  (def u (resource "user" (fn () "/api/users/7")))
  [:div
   [:button {:on-click "reload"} "Reload"]
   [:span (if (:loading @u) "..." (:name (:value @u)))]])

(define (reload ev) (resource/refresh! "user"))
```

A name is resolved against the component that owns the resource, which is what
makes the string form work from a delegated event handler where the handle the
render allocated is out of scope. That also means the handler has to belong to
the same component: a name declared in one component is not visible from
another's handler. An unknown *name* throws (it can only be a typo); an unknown
*handle* is a no-op, since a handle may legitimately outlive its component.

## `(resource/cancel! handle-or-name)`

Aborts the in-flight attempt. This is not a failure: `:loading` goes false,
`:value` and `:status` are untouched, and nothing is reported to the error
handler.

## Names, and one resource per component instance

`(resource "user" ...)` is memoized per component instance — that is what stops
"response writes signal -> re-render -> new resource -> new request" from
looping. A composed child rendered with `component/render` gets its own scope,
so each child instance owns its own resource:

```sema
(defcomponent user-card (props)
  (def u (resource "user" (fn () (string-append "/api/users/" (:id props)))))
  [:li {:key (:id props)} (if (:loading @u) "..." (:name (:value @u)))])

(defcomponent page ()
  ;; Two cards, two resources, two requests. Repeated children need `:key` in
  ;; their props — see the components guide.
  [:ul (map (fn (u) (component/render user-card (assoc u :key (:id u)))) @users)])
```

Two different components may use the same name without colliding.

The unnamed form `(resource spec-fn)` exists for module top level and other
places where no component owns the call. Inside a component — a render, an
effect body, an event handler, a timer callback — it is rejected, because every
one of those runs again and each run would allocate another signal, another
request, and another callback handle that nothing reclaims until unmount. Name
it instead.

## Ownership and teardown

A resource belongs to the component that created it. Unmounting the component,
or removing the composed child that owns it, aborts the in-flight request,
releases the spec callback, and drops the signal and its stream registration.
A response that arrives after teardown writes nothing and reports nothing.

With [dev mode](/docs/web/diagnostics) on, each resource records `open`,
`refetch`, and `close` entries in the diagnostics timeline.

## Errors

Every failure reaches two places: the `:error` field of the state, and the
runtime error handler installed via `SemaWeb.init({onerror})`, with context
`resource:<name>`.

| Failure                          | `:error`                       | `:status`      |
| -------------------------------- | ------------------------------ | -------------- |
| Spec threw, or returned no `:url` | The message                    | `nil`          |
| Transport failed                  | The message                    | `nil`          |
| Non-2xx response                  | `HTTP 404 - <body snippet>`    | The status      |
| Body would not decode             | `resource: response was not valid JSON` | The status |
| Deliberate `resource/cancel!`     | `nil` — not a failure          | unchanged       |

The URL is deliberately absent from what reaches `onerror`: the resource's name
identifies it, and a URL routinely carries ids and tokens.
