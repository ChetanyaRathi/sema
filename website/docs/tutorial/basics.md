---
outline: [2, 3]
---

# Basic Syntax

Sema is a Lisp, meaning it has a very simple and uniform syntax based on **S-expressions (symbolic expressions)**. If you have used Scheme or Clojure, you will feel right at home. If you are new to Lisp, this guide will introduce you to the core rules of the syntax.

---

## 1. S-Expressions and Prefix Notation

All code and data in Sema are represented as S-expressions. An expression is either a single value (like a number or string) or a list of expressions enclosed in parentheses.

In Sema, **operators and functions always come first**. This is called **prefix notation**:

```sema
(+ 1 2)         ; => 3
(* 10 (+ 2 3))  ; => 50 (10 * (2 + 3))
```

Here is how to read `(+ 1 2)`:
1. The opening parenthesis `(` starts a list.
2. The first element `+` is the function or operator to call.
3. The remaining elements `1` and `2` are the arguments passed to it.
4. The closing parenthesis `)` ends the call.

---

## 2. Comments

Comments in Sema start with a semicolon `;` and run to the end of the line:

```sema
; This is a single-line comment

(+ 1 2) ; This is an inline comment
```

By convention:
- A single semicolon `;` is used for inline comments.
- A double semicolon `;;` is used for comments on their own line.

---

## 3. Basic Types

Sema supports standard scalar types:

*   **Numbers**: Integers (`42`) and floats (`3.14`).
*   **Strings**: Double-quoted text (`"hello world"`).
*   **F-Strings**: Interpolated strings prefixed with `f` (`f"Hello ${name}"`).
*   **Booleans**: `#t` (true) and `#f` (false).
*   **Nil**: The null/empty value (`nil`).
*   **Keywords**: Colon-prefixed identifiers (`:name`, `:status`) commonly used as map keys or identifiers.

---

## 4. Variable Bindings

There are two primary ways to declare variables: globally and locally.

### Global Bindings (`define`)
Use `define` to bind a name to a value globally:

```sema
(define pi 3.14159)
(define radius 10)

(* pi (* radius radius)) ; => 314.159
```

### Local Bindings (`let`)
Use `let` to bind variables within a specific scope. The syntax uses a list of `(variable value)` pairs:

```sema
(let ((width 10)
      (height 5))
  (* width height)) ; => 50

;; 'width' and 'height' are not visible here
```

---

## 5. Core Collections

Sema supports three main collection types: Lists, Vectors, and Maps.

### Lists
Lists are ordered, linked collections. Since parentheses denote code execution, you create a literal list using the `list` function or by quoting it with `'`:

```sema
(list 1 2 3)    ; => (1 2 3)
'(1 2 3)        ; => (1 2 3)
```

### Vectors
Vectors are array-like collections with fast index-based access. They are defined using square brackets `[]`:

```sema
(define my-vector [10 20 30])
(nth my-vector 1)   ; => 20 (0-indexed)
```

### Maps
Maps are key-value structures. They are defined using curly braces `{}` and typically use keywords as keys:

```sema
(define user {:name "Ada" :age 36})
```

#### Keyword Accessors
In Sema, keywords act as accessor functions. You can look up a value in a map by calling the keyword with the map as an argument:

```sema
(:name user)    ; => "Ada"
(:age user)     ; => 36
```

---

## Next Steps

Now that you know how to represent data and variables, let's learn how to organize code into functions:
*   [Functions & Scope](./functions.md)
*   [Concurrency & Async](./concurrency.md)
