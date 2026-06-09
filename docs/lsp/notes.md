# LSP Notes, reference docs and ideas etc.

- https://github.com/ballerina-platform/lsp4intellij#compatibility-matrix
- http://lsp-devtools.readthedocs.io/
- https://pypi.org/project/lsp-devtools/
- https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html

## things to look into eventually.

- https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html#status-bar-integration

------

## Enesure we do this:

- https://github.com/JetBrains/intellij-sdk-docs/edit/main/topics/tutorials/writing_tests_for_plugins/writing_tests_for_plugins.md
- https://plugins.jetbrains.com/docs/intellij/testing-plugins.html
- https://plugins.jetbrains.com/docs/intellij/custom-language-support-tutorial.html
- https://plugins.jetbrains.com/docs/intellij/tests-prerequisites.html
- https://plugins.jetbrains.com/docs/intellij/folding-test.html
- https://plugins.jetbrains.com/docs/intellij/parsing-test.html
- https://plugins.jetbrains.com/docs/intellij/find-usages-test.html
- https://plugins.jetbrains.com/docs/intellij/completion-test.html
- https://plugins.jetbrains.com/docs/intellij/commenter-test.html
- https://plugins.jetbrains.com/docs/intellij/annotator-test.html
- https://plugins.jetbrains.com/docs/intellij/reference-test.html
- https://plugins.jetbrains.com/docs/intellij/formatter-test.html
- https://plugins.jetbrains.com/docs/intellij/documentation-test.html
- https://plugins.jetbrains.com/docs/intellij/rename-test.html

------

### Language Injection support

- https://plugins.jetbrains.com/docs/intellij/language-injection.html

This should work:

````sema
;; web-server.sema — Simple web server example
;; Run: cargo run -- examples/web-server.sema
;; Test: curl http://localhost:3000/greet/Ada

(define (handle-home req)
  (http/html "<h1>Welcome to Sema</h1><p>A Lisp with superpowers.</p>"))

(define (handle-greet req)
  (let ((name (or (:name (:params req)) "world")))
    (http/ok {:greeting (string/append "Hello, " name "!")})))

(define (handle-echo req)
  (http/ok
    {:method (:method req)
     :path (:path req)
     :query (:query req)
     :body (:body req)}))

(define (handle-health _)
  (http/ok {:status "up"}))

;; Middleware: add CORS headers
(define (with-cors handler)
  (fn (req)
    (let ((resp (handler req)))
      (if (map? resp)
        (assoc resp
          :headers
            (merge (or (:headers resp) {})
              {"access-control-allow-origin" "*"
               "access-control-allow-methods" "GET, POST, PUT, DELETE"}))
        resp))))

;; Middleware: request logging
(define (with-logging handler)
  (fn (req)
    (let ((resp (handler req)))
      (println (:method req) (:path req) "->" (:status resp))
      resp)))

;; Routes
(define routes
  [[:get "/" handle-home]
   [:get "/health" handle-health]
   [:get "/greet/:name" handle-greet]
   [:any "/echo" handle-echo]])

;; Build app with middleware
(define app (with-logging (with-cors (http/router routes))))

(println "Starting server on http://localhost:3000")
(http/serve app {:port 3000})
````