---
name: "define-syntax"
module: "special-forms"
syntax: "(define-syntax name (syntax-rules (literal ...) [(pattern) template] ...))"
---

Define a macro by pattern-matching rewrite rules. `define-syntax` binds a name to a `syntax-rules` transformer: a list of literal identifiers followed by rule pairs, each a pattern to match against the use site and a template to rewrite it into. The first rule whose pattern matches wins, and its template replaces the original form before evaluation.

`define-syntax` is the declarative counterpart to `defmacro`. Where `defmacro` runs arbitrary Sema code over its unevaluated arguments, `syntax-rules` states the shape transformation directly, which makes simple rewrites shorter and harder to get wrong. Choose `defmacro` when the expansion needs real computation.

The head of each pattern is conventionally written `_`, since it stands for the macro's own name:

```sema
(define-syntax swap
  (syntax-rules ()
    ((_ a b) (list b a))))

(swap 1 2)   ; => (2 1)
```

An ellipsis `...` matches zero or more forms in a pattern and splices them back in the template, so recursive rules can handle variable arity:

```sema
(define-syntax my-or
  (syntax-rules ()
    ((_)          #f)
    ((_ a)        a)
    ((_ a b ...)  (let ((t a)) (if t t (my-or b ...))))))

(my-or #f #f 3)   ; => 3
```

Identifiers listed in the literals list match only themselves, letting a macro define its own keywords:

```sema
(define-syntax my-if
  (syntax-rules (then else)
    ((_ c then t else e) (if c t e))))

(my-if #t then 1 else 2)   ; => 1
```

**Note:** the transformer is registered by the eval-side `__vm-define-syntax` helper, which receives the form quoted so the rules stay unevaluated.
