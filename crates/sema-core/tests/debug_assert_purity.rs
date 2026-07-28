//! Workspace lint: no `debug_assert*!` may carry a side effect.
//!
//! `cargo build --release` — which is what `wasm-pack` produces, what
//! `cargo-dist` ships, and therefore what every user runs — strips the whole
//! macro, taking any mutation written inside it with it. The assertion then
//! doubles as load-bearing state management in debug and as nothing at all in
//! release, and `cargo test` (debug by default) cannot see the difference: the
//! whole 7000-test suite was green while every browser build was broken.
//!
//! It has happened twice. `sema-vm`'s restricted owner kept a
//! `debug_assert_eq!(self.vm_frame_indices.pop(), …)`; release builds skipped
//! the pop, the stale index aimed `call_env` at a Continuation frame, and JS saw
//! `RuntimeError: unreachable`. `sema-wasm`'s `PromiseDebugDrive::begin` kept a
//! `debug_assert!(driver.debug_stop_requested.replace(None).is_none())`, whose
//! `.replace(None)` was doing double duty as the clear of stale re-entrancy
//! state. The per-file source greps left behind by the first fix structurally
//! could not see the second, so this one walks the whole workspace.
//!
//! The correct shape is always the same: perform the mutation as its own
//! statement, then assert on the value it produced.
//!
//! ```ignore
//! let popped = self.vm_frame_indices.pop();
//! debug_assert_eq!(popped, Some(index));
//! ```

use std::fs;
use std::path::{Path, PathBuf};

/// Method calls that change state the program can observe afterwards.
///
/// Deliberately a closed list of *mutators* rather than "anything with a
/// receiver": a lint that fires on `debug_assert!(v.len() == 2)` gets suppressed
/// and then deleted. Read-only calls (`get`, `len`, `peek`, `iter`, `contains`)
/// are absent on purpose, as is `next` — building a fresh iterator inside an
/// assertion observes nothing outside it.
const MUTATORS: &[&str] = &[
    "append",
    "borrow_mut",
    "clear",
    "drain",
    "extend",
    "fetch_add",
    "fetch_and",
    "fetch_or",
    "fetch_sub",
    "fetch_xor",
    "get_mut",
    "insert",
    "iter_mut",
    "pop",
    "pop_back",
    "pop_front",
    "push",
    "push_back",
    "push_front",
    "push_str",
    "remove",
    "replace",
    "retain",
    "send",
    "set",
    "split_off",
    "store",
    "swap",
    "take",
    "truncate",
];

/// Blank out comments and string/char literal contents.
///
/// Keeps byte offsets stable so the scan can still report a line number, and
/// stops the lint from tripping over its own vocabulary: the very guard this
/// generalizes lives in a string literal that names `pop()`.
fn mask_literals(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out: Vec<u8> = bytes.to_vec();
    let mut i = 0usize;

    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for slot in out.iter_mut().take(to).skip(from) {
            if *slot != b'\n' {
                *slot = b' ';
            }
        }
    };

    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                let start = i;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                blank(&mut out, start, i);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let start = i;
                let mut depth = 1usize;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                blank(&mut out, start, i);
            }
            b'r' if matches!(bytes.get(i + 1), Some(b'"') | Some(b'#')) => {
                // Raw string: r"…", r#"…"#, r##"…"##.
                let mut hashes = 0usize;
                let mut j = i + 1;
                while bytes.get(j) == Some(&b'#') {
                    hashes += 1;
                    j += 1;
                }
                if bytes.get(j) != Some(&b'"') {
                    i += 1;
                    continue;
                }
                let start = i;
                j += 1;
                loop {
                    if j >= bytes.len() {
                        break;
                    }
                    if bytes[j] == b'"' {
                        let closing = (1..=hashes).all(|k| bytes.get(j + k) == Some(&b'#'));
                        if closing {
                            j += hashes + 1;
                            break;
                        }
                    }
                    j += 1;
                }
                blank(&mut out, start, j);
                i = j;
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() {
                    match bytes[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                blank(&mut out, start, i);
            }
            b'\'' => {
                // A char literal, or a lifetime — `'a` has no closing quote, so
                // only blank when one turns up within four bytes.
                let start = i;
                let mut j = i + 1;
                let mut closed = None;
                while j < bytes.len() && j <= i + 4 {
                    if bytes[j] == b'\\' {
                        j += 2;
                        continue;
                    }
                    if bytes[j] == b'\'' {
                        closed = Some(j + 1);
                        break;
                    }
                    j += 1;
                }
                match closed {
                    Some(end) => {
                        blank(&mut out, start, end);
                        i = end;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }

    String::from_utf8(out).expect("masking preserves utf-8 boundaries")
}

/// The macro invocation's argument list, delimiter-matched.
fn macro_body(masked: &str, open: usize) -> Option<&str> {
    let bytes = masked.as_bytes();
    let (opening, closing) = match bytes[open] {
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        b'{' => (b'{', b'}'),
        _ => return None,
    };
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        if bytes[i] == opening {
            depth += 1;
        } else if bytes[i] == closing {
            depth -= 1;
            if depth == 0 {
                return Some(&masked[open + 1..i]);
            }
        }
        i += 1;
    }
    None
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name == "target" || name.starts_with('.') {
                continue;
            }
            rust_files(&path, out);
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_debug_assert_in_the_workspace_carries_a_side_effect() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/ is the parent of this crate")
        .to_path_buf();
    let mut files = Vec::new();
    rust_files(&crates, &mut files);
    assert!(
        files.len() > 100,
        "expected to scan the whole workspace, found only {} files under {}",
        files.len(),
        crates.display()
    );

    let this_file = Path::new(file!()).file_name().map(|n| n.to_owned());
    let mut offenders = Vec::new();
    let mut scanned = 0usize;

    for file in &files {
        if file.file_name().map(|n| n.to_owned()) == this_file {
            continue; // The lint's own vocabulary is not a finding.
        }
        let Ok(source) = fs::read_to_string(file) else {
            continue;
        };
        if !source.contains("debug_assert") {
            continue;
        }
        let masked = mask_literals(&source);

        let mut search = 0usize;
        while let Some(found) = masked[search..].find("debug_assert") {
            let at = search + found;
            search = at + "debug_assert".len();
            let rest = &masked[search..];
            let after = rest
                .strip_prefix("_eq")
                .or_else(|| rest.strip_prefix("_ne"))
                .unwrap_or(rest);
            let Some(args) = after.strip_prefix('!') else {
                continue;
            };
            let open = masked.len() - args.len();
            let Some(body) = macro_body(&masked, open) else {
                continue;
            };
            scanned += 1;

            for mutator in MUTATORS {
                let call = format!(".{mutator}(");
                if body.contains(&call) {
                    let line = masked[..at].matches('\n').count() + 1;
                    offenders.push(format!(
                        "{}:{line}: `{call})` inside a debug_assert",
                        file.display()
                    ));
                }
            }
        }
    }

    assert!(
        scanned > 20,
        "expected to find the workspace's debug_assert sites, found {scanned}"
    );
    assert!(
        offenders.is_empty(),
        "a release build strips debug_assert*! entirely, taking these mutations with it. \
         Perform the mutation as its own statement and assert on its result:\n  {}",
        offenders.join("\n  ")
    );
}
