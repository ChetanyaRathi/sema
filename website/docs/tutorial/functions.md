---
outline: [2, 3]
---

# Functions and Scope

Functions are the primary building blocks of Sema programs. Functions in Sema are first-class, meaning they can be bound to variables, passed as arguments to other functions, and returned from functions.

---

## 1. Defining Named Functions

There are two equivalent ways to define a named function:

### The `defn` Macro
By convention, the `defn` macro is the most common way to declare a function:

```sema
(defn square (x)
  (* x x))

(square 5) ; => 25
```

### The `define` Shorthand
You can also define functions using a shorthand syntax with `define`:

```sema
(define (square x)
  (* x x))
```

---

## 2. Anonymous Functions (Lambdas)

Anonymous functions are functions without a name, commonly used when passing functions to higher-order helpers like `map` or `filter`.

### Using `fn`
You can define an anonymous function using the `fn` form:

```sema
(map (fn (x) (* x x)) '(1 2 3))
; => (1 4 9)
```

### Shorthand Lambdas `#(...)`
Sema provides a compact Clojure-style shorthand syntax for short anonymous functions.
- `#(...)` creates an anonymous function.
- `%` represents the first argument (or you can use `%1`, `%2`, etc., for multiple arguments).

```sema
;; Square a number
(map #(* % %) '(1 2 3)) ; => (1 4 9)

;; Add two numbers
(define add #(+ %1 %2))
(add 10 20) ; => 30
```

---

## 3. Scope and Closures

Sema functions are **lexically scoped**. This means they can access variables declared in their outer parent scopes. When a function references variables from its enclosing scope, it creates a **closure**:

```sema
(defn make-adder (x)
  (fn (y) (+ x y)))

(define add-five (make-adder 5))
(add-five 10) ; => 15
```

In the example above, `add-five` remembers the value of `x` (which is `5`) even after `make-adder` has finished execution.

---

## 4. Recursion and Tail-Call Optimization (TCO)

While Sema supports iterative forms, the standard way to perform repetitive tasks is via **recursion**.

Sema implements **Tail-Call Optimization (TCO)**. When a function calls itself (or another function) in the **tail position** (meaning the call is the absolute last action in the function), the runtime reuses the current stack frame instead of allocating a new one. This prevents stack overflow errors, regardless of how deep the recursion is.

### Example: Tail-Recursive Factorial
A function is tail-recursive if the recursive call's value is directly returned without further computation:

```sema
(defn factorial (n accumulator)
  (if (<= n 1)
      accumulator
      (factorial (- n 1) (* n accumulator)))) ; Tail position

(factorial 5 1) ; => 120
```

Contrast this with a non-tail-recursive version where the recursive call is not the last operation:

```sema
(defn factorial-bad (n)
  (if (<= n 1)
      1
      (* n (factorial-bad (- n 1))))) ; NOT in tail position (* must run after)
```

---

## Next Steps

Now that you know how to write functions, let's look at how Sema handles concurrency and asynchronous programming:
*   [Concurrency & Async](./concurrency.md)
