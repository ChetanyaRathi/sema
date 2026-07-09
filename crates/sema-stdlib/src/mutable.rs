//! In-place mutable containers: `mutable-array/*` and `mutable-cell/*`.
//!
//! These wrap [`sema_core::MutableArray`] / [`sema_core::MutableCell`] —
//! reference-shared, interior-mutable heap values for Janet-style imperative
//! hot loops (e.g. accumulating per-station stats in the 1BRC benchmark)
//! where the persistent containers' copy-on-write costs dominate. Freeze
//! with `mutable-array/->vector` to hand data back to the immutable world.

use sema_core::{check_arity, SemaError, Value};

use crate::register_fn;

fn as_array<'a>(v: &'a Value, name: &str) -> Result<&'a sema_core::MutableArray, SemaError> {
    v.as_mutable_array().ok_or_else(|| {
        SemaError::type_error("mutable-array", v.type_name())
            .with_hint(format!("{name}: create one with (mutable-array/new)"))
    })
}

fn as_cell<'a>(v: &'a Value, name: &str) -> Result<&'a sema_core::MutableCell, SemaError> {
    v.as_mutable_cell().ok_or_else(|| {
        SemaError::type_error("mutable-cell", v.type_name())
            .with_hint(format!("{name}: create one with (mutable-cell/new v)"))
    })
}

pub fn register(env: &sema_core::Env) {
    register_fn(env, "mutable-array/new", |args| {
        check_arity!(args, "mutable-array/new", 0..=2);
        match args.len() {
            // Capacity pre-allocation (Janet's `array/new`): the array starts
            // empty; the hint just avoids growth reallocations while pushing.
            0 | 1 => {
                let cap = if args.is_empty() {
                    0
                } else {
                    args[0].as_index("mutable-array/new")?
                };
                Ok(Value::mutable_array(Vec::with_capacity(cap)))
            }
            // Filled construction (Janet's `array/new-filled`): n copies of
            // the fill value, ready for indexed `mutable-array/set!`.
            _ => {
                let n = args[0].as_index("mutable-array/new")?;
                Ok(Value::mutable_array(vec![args[1].clone(); n]))
            }
        }
    });

    register_fn(env, "mutable-array/push!", |args| {
        check_arity!(args, "mutable-array/push!", 2);
        let arr = as_array(&args[0], "mutable-array/push!")?;
        arr.items.borrow_mut().push(args[1].clone());
        Ok(args[0].clone())
    });

    register_fn(env, "mutable-array/get", |args| {
        check_arity!(args, "mutable-array/get", 2..=3);
        let arr = as_array(&args[0], "mutable-array/get")?;
        let idx = args[1].as_index("mutable-array/get")?;
        let items = arr.items.borrow();
        match items.get(idx) {
            Some(v) => Ok(v.clone()),
            None if args.len() == 3 => Ok(args[2].clone()),
            None => Err(SemaError::eval(format!(
                "mutable-array/get: index {idx} out of bounds (length {})",
                items.len()
            ))),
        }
    });

    register_fn(env, "mutable-array/set!", |args| {
        check_arity!(args, "mutable-array/set!", 3);
        let arr = as_array(&args[0], "mutable-array/set!")?;
        let idx = args[1].as_index("mutable-array/set!")?;
        let mut items = arr.items.borrow_mut();
        let len = items.len();
        match items.get_mut(idx) {
            Some(slot) => {
                *slot = args[2].clone();
                drop(items);
                Ok(args[0].clone())
            }
            None => Err(SemaError::eval(format!(
                "mutable-array/set!: index {idx} out of bounds (length {len})"
            ))
            .with_hint("set! writes to an existing slot; use mutable-array/push! to grow")),
        }
    });

    register_fn(env, "mutable-array/length", |args| {
        check_arity!(args, "mutable-array/length", 1);
        let arr = as_array(&args[0], "mutable-array/length")?;
        Ok(Value::int(arr.items.borrow().len() as i64))
    });

    register_fn(env, "mutable-array/->vector", |args| {
        check_arity!(args, "mutable-array/->vector", 1);
        let arr = as_array(&args[0], "mutable-array/->vector")?;
        Ok(Value::vector(arr.items.borrow().clone()))
    });

    register_fn(env, "mutable-cell/new", |args| {
        check_arity!(args, "mutable-cell/new", 1);
        Ok(Value::mutable_cell(args[0].clone()))
    });

    register_fn(env, "mutable-cell/get", |args| {
        check_arity!(args, "mutable-cell/get", 1);
        let cell = as_cell(&args[0], "mutable-cell/get")?;
        let slot = cell.value.borrow();
        Ok(slot.clone())
    });

    register_fn(env, "mutable-cell/set!", |args| {
        check_arity!(args, "mutable-cell/set!", 2);
        let cell = as_cell(&args[0], "mutable-cell/set!")?;
        *cell.value.borrow_mut() = args[1].clone();
        Ok(args[0].clone())
    });
}
