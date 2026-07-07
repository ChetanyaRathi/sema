use std::cmp::Ordering;

use sema_core::num::cmp_int_float;
use sema_core::{check_arity, SemaError, Value, ValueViewRef};

use crate::register_fn;

/// Exact numeric ordering across int/float, or `None` for NaN. Errors if either
/// argument is not a number.
fn num_partial_cmp(a: &Value, b: &Value) -> Result<Option<Ordering>, SemaError> {
    match (a.view_ref(), b.view_ref()) {
        (ValueViewRef::Int(x), ValueViewRef::Int(y)) => Ok(Some(x.cmp(&y))),
        (ValueViewRef::Float(x), ValueViewRef::Float(y)) => Ok(x.partial_cmp(&y)),
        (ValueViewRef::Int(x), ValueViewRef::Float(y)) => Ok(cmp_int_float(x, y)),
        (ValueViewRef::Float(x), ValueViewRef::Int(y)) => {
            Ok(cmp_int_float(y, x).map(Ordering::reverse))
        }
        (ValueViewRef::Int(_) | ValueViewRef::Float(_), _) => {
            Err(SemaError::type_error("number", b.type_name()))
        }
        _ => Err(SemaError::type_error("number", a.type_name())),
    }
}

fn num_cmp(
    args: &[Value],
    op: &str,
    want: impl Fn(Option<Ordering>) -> bool,
) -> Result<Value, SemaError> {
    check_arity!(args, op, 2..);
    for pair in args.windows(2) {
        if !want(num_partial_cmp(&pair[0], &pair[1])?) {
            return Ok(Value::bool(false));
        }
    }
    Ok(Value::bool(true))
}

pub fn register(env: &sema_core::Env) {
    register_fn(env, "<", |args| {
        num_cmp(args, "<", |o| o == Some(Ordering::Less))
    });
    register_fn(env, ">", |args| {
        num_cmp(args, ">", |o| o == Some(Ordering::Greater))
    });
    register_fn(env, "<=", |args| {
        num_cmp(args, "<=", |o| {
            matches!(o, Some(Ordering::Less | Ordering::Equal))
        })
    });
    register_fn(env, ">=", |args| {
        num_cmp(args, ">=", |o| {
            matches!(o, Some(Ordering::Greater | Ordering::Equal))
        })
    });

    register_fn(env, "=", |args| {
        check_arity!(args, "=", 2..);
        for pair in args.windows(2) {
            match (pair[0].view_ref(), pair[1].view_ref()) {
                (ValueViewRef::Int(a), ValueViewRef::Int(b)) => {
                    if a != b {
                        return Ok(Value::bool(false));
                    }
                }
                (ValueViewRef::Int(a), ValueViewRef::Float(b))
                | (ValueViewRef::Float(b), ValueViewRef::Int(a)) => {
                    if cmp_int_float(a, b) != Some(Ordering::Equal) {
                        return Ok(Value::bool(false));
                    }
                }
                (ValueViewRef::Float(a), ValueViewRef::Float(b)) => {
                    if a != b {
                        return Ok(Value::bool(false));
                    }
                }
                _ => {
                    if pair[0] != pair[1] {
                        return Ok(Value::bool(false));
                    }
                }
            }
        }
        Ok(Value::bool(true))
    });

    register_fn(env, "eq?", |args| {
        check_arity!(args, "eq?", 2);
        Ok(Value::bool(args[0] == args[1]))
    });

    register_fn(env, "not", |args| {
        check_arity!(args, "not", 1);
        Ok(Value::bool(!args[0].is_truthy()))
    });

    register_fn(env, "zero?", |args| {
        check_arity!(args, "zero?", 1);
        match args[0].view_ref() {
            ValueViewRef::Int(n) => Ok(Value::bool(n == 0)),
            ValueViewRef::Float(f) => Ok(Value::bool(f == 0.0)),
            _ => Err(SemaError::type_error("number", args[0].type_name())),
        }
    });

    register_fn(env, "positive?", |args| {
        check_arity!(args, "positive?", 1);
        match args[0].view_ref() {
            ValueViewRef::Int(n) => Ok(Value::bool(n > 0)),
            ValueViewRef::Float(f) => Ok(Value::bool(f > 0.0)),
            _ => Err(SemaError::type_error("number", args[0].type_name())),
        }
    });

    register_fn(env, "negative?", |args| {
        check_arity!(args, "negative?", 1);
        match args[0].view_ref() {
            ValueViewRef::Int(n) => Ok(Value::bool(n < 0)),
            ValueViewRef::Float(f) => Ok(Value::bool(f < 0.0)),
            _ => Err(SemaError::type_error("number", args[0].type_name())),
        }
    });

    register_fn(env, "even?", |args| {
        check_arity!(args, "even?", 1);
        match args[0].view_ref() {
            ValueViewRef::Int(n) => Ok(Value::bool(n % 2 == 0)),
            _ => Err(SemaError::type_error("int", args[0].type_name())),
        }
    });

    register_fn(env, "odd?", |args| {
        check_arity!(args, "odd?", 1);
        match args[0].view_ref() {
            ValueViewRef::Int(n) => Ok(Value::bool(n % 2 != 0)),
            _ => Err(SemaError::type_error("int", args[0].type_name())),
        }
    });
}
