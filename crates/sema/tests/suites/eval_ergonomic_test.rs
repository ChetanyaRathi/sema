use sema_core::Value;

// ============================================================
// F-strings
// ============================================================

eval_tests! {
    fstring_basic: r#"(let ((name "world")) f"hello ${name}")"# => Value::string("hello world"),
    fstring_multiple: r#"(let ((a "foo") (b "bar")) f"${a} and ${b}")"# => Value::string("foo and bar"),
    fstring_expression: r#"f"result: ${(+ 1 2)}""# => Value::string("result: 3"),
    fstring_nested_call: r#"(let ((x 42)) f"the answer is ${x}")"# => Value::string("the answer is 42"),
    fstring_no_interpolation: r#"f"just a string""# => Value::string("just a string"),
    fstring_keyword_access: r#"(let ((m {:name "Ada"})) f"name: ${(:name m)}")"# => Value::string("name: Ada"),
    fstring_escaped_dollar: r#"f"costs \$5""# => Value::string("costs $5"),
    fstring_dollar_without_brace: r#"f"costs $5""# => Value::string("costs $5"),
}

// ============================================================
// Short lambdas
// ============================================================

eval_tests! {
    short_lambda_basic: "(map #(+ % 1) '(1 2 3))" => Value::list(vec![Value::int(2), Value::int(3), Value::int(4)]),
    short_lambda_square: "(map #(* % %) '(1 2 3 4))" => Value::list(vec![Value::int(1), Value::int(4), Value::int(9), Value::int(16)]),
    short_lambda_filter: "(filter #(> % 3) '(1 2 3 4 5))" => Value::list(vec![Value::int(4), Value::int(5)]),
    short_lambda_two_args: "(#(+ %1 %2) 3 4)" => Value::int(7),
    short_lambda_no_args: "(#(+ 1 2))" => Value::int(3),
    short_lambda_nested_call: r#"(map #(string-length %) '("hi" "hello" "hey"))"# => Value::list(vec![Value::int(2), Value::int(5), Value::int(3)]),
}

// ============================================================
// Threading macros
// ============================================================

eval_tests! {
    thread_first: "(-> 5 (+ 3) (* 2))" => Value::int(16),
    thread_first_bare_fn: r#"(-> "hello" string-length)"# => Value::int(5),
    thread_last: "(->> (range 1 6) (filter odd?))" => Value::list(vec![Value::int(1), Value::int(3), Value::int(5)]),
    thread_last_pipeline: "(->> (range 1 6) (map (fn (x) (* x x))) (foldl + 0))" => Value::int(55),
    thread_as: "(as-> 5 x (+ x 3) (* x x) (- x 1))" => Value::int(63),
    some_thread_non_nil: r#"(some-> {:a {:b 42}} (get :a) (get :b))"# => Value::int(42),
    some_thread_nil: r#"(some-> {:a nil} (get :a) (get :b))"# => Value::nil(),
}

// ============================================================
// when-let / if-let
// ============================================================

eval_tests! {
    when_let_truthy: "(when-let (x 42) (+ x 1))" => Value::int(43),
    when_let_nil: "(when-let (x nil) (+ x 1))" => Value::nil(),
    if_let_truthy: "(if-let (x 42) (+ x 1) 0)" => Value::int(43),
    if_let_nil: "(if-let (x nil) (+ x 1) 0)" => Value::int(0),
}

// ============================================================
// Reader / lowering regressions (2026-07-27 sweep)
// ============================================================

eval_tests! {
    // R7RS 4.2.8: a nested quasiquote raises the level, so the inner unquote is
    // DATA here, not a substitution. Without level tracking the inner `,c` was
    // evaluated one level too early — the bug that breaks macro-writing macros.
    nested_quasiquote_keeps_the_inner_unquote_as_data:
        "(define c 42) (str `(a `(b ,c)))"
        => Value::string("(a (quasiquote (b (unquote c))))"),
    // Doubled unquote reaches the outer level and DOES evaluate; previously it
    // leaked the bare symbol `unquote` into operator position.
    nested_quasiquote_double_unquote_evaluates_at_the_outer_level:
        "(define x 5) (str `(a `(b ,,x)))"
        => Value::string("(a (quasiquote (b (unquote 5))))"),
    nested_quasiquote_splice_stays_data_when_nested:
        "(define xs (list 1 2)) (str `(a `(b ,@xs)))"
        => Value::string("(a (quasiquote (b (unquote-splicing xs))))"),
    // Single-level behavior must be untouched by the level tracking.
    quasiquote_single_level_still_substitutes:
        "(define x 2) (str `(1 ,x 3))" => Value::string("(1 2 3)"),
    quasiquote_single_level_still_splices:
        "(define xs (list 2 3)) (str `(1 ,@xs 4))" => Value::string("(1 2 3 4)"),

    // `rewrite_percent_args` skipped map literals, so `%` inside `{...}` was
    // neither renamed nor counted and the lambda came out with arity 0 —
    // reported as a confusing arity error that never mentioned the `%`.
    short_lambda_counts_percent_inside_a_map_literal:
        "(str (map #(list {:n %}) (list 1 2)))" => Value::string("(({:n 1}) ({:n 2}))"),
    short_lambda_percent_in_a_map_key:
        "(str (map #(get {:a 10 :b 20} %) (list :a :b)))" => Value::string("(10 20)"),

    // The raw-regex scanner only paired `\` with a following `"`, so the second
    // backslash of a trailing `\\` consumed the terminator and the literal was
    // reported as an unterminated string.
    regex_literal_ending_in_an_escaped_backslash:
        r#"(regex/match? #"\\" "a")"# => Value::bool(false),
    regex_literal_matches_a_literal_backslash:
        r#"(regex/match? #"a\\b" "a\\b")"# => Value::bool(true),
}

eval_error_tests! {
    // `read_number` indexed chars[0] unconditionally, so a source ending in an
    // exactness-only prefix aborted the process instead of erroring.
    hash_inexact_prefix_at_eof: "#i",
    hash_exact_prefix_at_eof: "#e",
    hash_decimal_prefix_at_eof: "#d",
}
