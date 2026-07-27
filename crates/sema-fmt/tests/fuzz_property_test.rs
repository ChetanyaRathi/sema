//! Property fuzzer: generates seeded random Sema programs (atoms, special
//! forms, collections, comments, prefixes, odd whitespace) and checks five
//! oracles at four option sets: reader-valid input must format, the output
//! must reparse, it must read to the SAME values, the comment count must not
//! change, and formatting must be idempotent. Deterministic — failures
//! reproduce from the printed seed. 2000 seeds keeps it fast for CI; crank
//! the range up locally when hunting.
use sema_fmt::{format_source, FormatOptions};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const HEADS: &[&str] = &[
    "define",
    "def",
    "defn",
    "let",
    "let*",
    "if",
    "cond",
    "case",
    "match",
    "when",
    "unless",
    "do",
    "begin",
    "progn",
    "async",
    "fn",
    "lambda",
    "->",
    "->>",
    "try",
    "while",
    "dotimes",
    "for-range",
    "parameterize",
    "guard",
    "hash-map",
    "assoc",
    "list",
    "my-function",
    "+",
    "string/split",
    "f",
    "g",
];
const ATOMS: &[&str] = &[
    "x",
    "yy",
    "zzz",
    "foo-bar",
    "n?",
    "set!",
    ":kw",
    ":a/b",
    "1",
    "-42",
    "3.5",
    "#t",
    "#f",
    "nil",
    "\"str\"",
    "\"a b\"",
    "\"has;semi\"",
    "\"esc\\\"q\"",
    "#\"re+\"",
    "f\"i${x}p\"",
    "255",
    "λ",
];

fn gen_node(r: &mut Rng, depth: usize, out: &mut String) {
    let choice = if depth > 4 { r.pick(3) } else { r.pick(10) };
    match choice {
        0 | 1 => out.push_str(ATOMS[r.pick(ATOMS.len())]),
        2 => {
            out.push(':');
            out.push_str(["a", "bb", "ccc"][r.pick(3)]);
        }
        3 | 4 => {
            // list with head
            out.push('(');
            out.push_str(HEADS[r.pick(HEADS.len())]);
            let n = r.pick(4);
            for _ in 0..n {
                sep(r, depth, out);
                gen_node(r, depth + 1, out);
            }
            maybe_comment_nl(r, out, depth);
            out.push(')');
        }
        5 => {
            // vector
            out.push('[');
            let n = r.pick(4);
            for i in 0..n {
                if i > 0 {
                    sep(r, depth, out);
                }
                gen_node(r, depth + 1, out);
            }
            out.push(']');
        }
        6 => {
            // map, even entries
            out.push('{');
            let n = r.pick(3);
            for i in 0..n {
                if i > 0 {
                    sep(r, depth, out);
                }
                out.push(':');
                out.push_str(["k", "kk", "kkk"][r.pick(3)]);
                sep(r, depth, out);
                gen_node(r, depth + 1, out);
            }
            out.push('}');
        }
        7 => {
            // prefix
            out.push_str(["'", "`", ",", ",@", "@"][r.pick(5)]);
            gen_node(r, depth + 1, out);
        }
        8 => {
            // bytevector
            out.push_str("#u8(");
            let n = r.pick(6);
            for i in 0..n {
                if i > 0 {
                    out.push(' ');
                }
                out.push_str(&(r.pick(256)).to_string());
            }
            out.push(')');
        }
        _ => {
            // short lambda (no nesting worry: reader rejects, we skip invalid)
            out.push_str("#(+ % ");
            gen_node(r, depth + 1, out);
            out.push(')');
        }
    }
}

fn sep(r: &mut Rng, depth: usize, out: &mut String) {
    match r.pick(8) {
        0 => out.push_str("\n "),
        1 => {
            out.push_str(" ;; c\n ");
        }
        2 => out.push_str("  "),
        3 if depth < 2 => out.push_str("\n\n "),
        _ => out.push(' '),
    }
}

fn maybe_comment_nl(r: &mut Rng, out: &mut String, _depth: usize) {
    if r.pick(6) == 0 {
        out.push_str(" ;; tail\n ");
    }
}

fn count_comments(src: &str) -> usize {
    let mut count = 0;
    let mut chars = src.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            chars.next();
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            ';' => {
                count += 1;
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    count
}

#[test]
fn fuzz_property() {
    let mut valid = 0u32;
    let mut failures = 0u32;
    for seed in 0..2000u64 {
        let mut r = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let mut src = String::new();
        let nforms = 1 + r.pick(3);
        for i in 0..nforms {
            if i > 0 {
                src.push_str(["\n", "\n\n", "\n;; between\n"][r.pick(3)]);
            }
            gen_node(&mut r, 0, &mut src);
        }
        let Ok(input_values) = sema_reader::read_many(&src) else {
            continue;
        };
        valid += 1;
        let in_comments = count_comments(&src);
        for (oname, opts) in [
            ("default", FormatOptions::default()),
            (
                "align",
                FormatOptions {
                    align: true,
                    ..Default::default()
                },
            ),
            (
                "narrow",
                FormatOptions {
                    width: 30,
                    ..Default::default()
                },
            ),
        ] {
            let out = match format_source(&src, &opts) {
                Ok(o) => o,
                Err(e) => {
                    failures += 1;
                    println!("!!! seed {seed} [{oname}] FORMAT-ERR {e}\nsrc: {src:?}");
                    continue;
                }
            };
            match sema_reader::read_many(&out) {
                Ok(v) if v == input_values => {}
                Ok(_) => {
                    failures += 1;
                    println!("!!! seed {seed} [{oname}] SEMANTICS\nsrc: {src:?}\nout: {out:?}");
                }
                Err(e) => {
                    failures += 1;
                    println!(
                        "!!! seed {seed} [{oname}] UNPARSEABLE {e}\nsrc: {src:?}\nout: {out:?}"
                    );
                }
            }
            if count_comments(&out) != in_comments {
                failures += 1;
                println!(
                    "!!! seed {seed} [{oname}] COMMENTS {} -> {}\nsrc: {src:?}\nout: {out:?}",
                    in_comments,
                    count_comments(&out)
                );
            }
            match format_source(&out, &opts) {
                Ok(again) if again == out => {}
                Ok(again) => {
                    failures += 1;
                    println!("!!! seed {seed} [{oname}] NON-IDEMPOTENT\nsrc: {src:?}\n1st: {out:?}\n2nd: {again:?}");
                }
                Err(e) => {
                    failures += 1;
                    println!(
                        "!!! seed {seed} [{oname}] REFORMAT-ERR {e}\nsrc: {src:?}\nout: {out:?}"
                    );
                }
            }
            if failures > 30 {
                panic!("too many failures, aborting early");
            }
        }
    }
    println!("fuzz: {valid} valid samples, {failures} failures");
    assert_eq!(failures, 0);
}
