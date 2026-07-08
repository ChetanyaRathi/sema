//! `sema-docs` CLI — reads the canonical structured doc source and produces the LSP/REPL index.

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

// Canonical source + generated index live inside the crate (NOT under docs/, which is for plans).
const STDLIB_SRC: &str = "crates/sema-docs/entries/stdlib";
const SPECIAL_FORMS_SRC: &str = "crates/sema-docs/entries/special-forms";
const INDEX_OUT: &str = "crates/sema-docs/builtin_docs.generated.json";

#[derive(Parser)]
#[command(
    name = "sema-docs",
    about = "Sema builtin documentation indexer",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Repository root (default: current directory)
    #[arg(long, global = true)]
    root: Option<PathBuf>,

    /// Fail on empty summaries (CI gate)
    #[arg(long, global = true)]
    strict: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Load + validate docs without writing
    Check,
    /// Regenerate builtin_docs.generated.json
    Gen,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = cli.root.unwrap_or_else(|| PathBuf::from("."));
    let strict = cli.strict;

    let result = match cli.command {
        Commands::Check => cmd_check(&root, strict),
        Commands::Gen => cmd_gen(&root, strict),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("sema-docs: {e}");
            ExitCode::FAILURE
        }
    }
}

fn load_validated(
    root: &Path,
    strict: bool,
) -> Result<Vec<sema_docs::DocEntry>, Box<dyn std::error::Error>> {
    let entries = sema_docs::load(&root.join(STDLIB_SRC), &root.join(SPECIAL_FORMS_SRC))?;
    // Validate the RAW entries: a duplicate (module, name)/(module, alias) pair is a HARD
    // error that fails generation. This is deliberately not run after `dedupe` — letting
    // dedupe drop the collision first would silently discard a real builtin's doc entry
    // from the index (e.g. an alias colliding with another entry's canonical name) while
    // the gate stayed green. `dedupe` is retained (see lib.rs / entry_tests) but is no
    // longer in the generation path, so uniqueness is enforced, never papered over.
    let warnings = sema_docs::validate(&entries, strict)?;
    if !warnings.is_empty() {
        eprintln!("warning: {} issue(s):", warnings.len());
        for w in &warnings {
            eprintln!("  - {w}");
        }
    }
    Ok(entries)
}

fn cmd_check(root: &Path, strict: bool) -> Result<(), Box<dyn std::error::Error>> {
    let entries = load_validated(root, strict)?;
    println!("ok: {} entries", entries.len());
    Ok(())
}

fn cmd_gen(root: &Path, strict: bool) -> Result<(), Box<dyn std::error::Error>> {
    let entries = load_validated(root, strict)?;
    let n = entries.len();
    let index = sema_docs::build_index(entries);
    let json = serde_json::to_string_pretty(&index)? + "\n";
    write_if_changed(&root.join(INDEX_OUT), &json)?;
    println!("generated {n} entries -> {INDEX_OUT}");
    Ok(())
}

/// Idempotent write so `make docs` produces no diff when nothing changed.
fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    std::fs::write(path, content)
}
