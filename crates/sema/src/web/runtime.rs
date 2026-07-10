//! The browser runtime `sema web` serves: the WASM VM glue + JS bundle a
//! sema-web app needs to boot with no bundler. The generated assets are tracked
//! package inputs and embedded in every Sema binary via `include_bytes!`.

mod embedded {
    /// (served-relative path, bytes) for each vendored file. The set mirrors the
    /// import map the dev server generates: sema-web → sema → sema-wasm, plus the
    /// signals/morphdom runtime deps and the storage backends `sema/index.js`
    /// statically imports. The `.wasm` glue fetches `sema_wasm_bg.wasm` relative
    /// to its own URL, so the two must stay co-located under the same prefix.
    pub const ASSETS: &[(&str, &[u8])] = &[
        ("sema-web.js", include_bytes!("assets/sema-web.js")),
        ("sema/index.js", include_bytes!("assets/sema/index.js")),
        ("sema/vfs.js", include_bytes!("assets/sema/vfs.js")),
        (
            "sema/backends/memory.js",
            include_bytes!("assets/sema/backends/memory.js"),
        ),
        (
            "sema/backends/local-storage.js",
            include_bytes!("assets/sema/backends/local-storage.js"),
        ),
        (
            "sema/backends/session-storage.js",
            include_bytes!("assets/sema/backends/session-storage.js"),
        ),
        (
            "sema/backends/indexed-db.js",
            include_bytes!("assets/sema/backends/indexed-db.js"),
        ),
        (
            "sema/backends/web-storage.js",
            include_bytes!("assets/sema/backends/web-storage.js"),
        ),
        ("sema_wasm.js", include_bytes!("assets/sema_wasm.js")),
        (
            "sema_wasm_bg.wasm",
            include_bytes!("assets/sema_wasm_bg.wasm"),
        ),
        (
            "signals-core.module.js",
            include_bytes!("assets/signals-core.module.js"),
        ),
        ("morphdom-esm.js", include_bytes!("assets/morphdom-esm.js")),
    ];
}

/// Extract the embedded runtime to a versioned temp dir and return its path, so
/// the dev server can serve it as static files. Idempotent: a file is rewritten
/// only when missing or size-mismatched, keeping the ~3 MB wasm write off the
/// hot path on repeat launches.
pub fn extract() -> std::io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(concat!("sema-web-runtime-", env!("CARGO_PKG_VERSION")));
    for (rel, bytes) in embedded::ASSETS {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let needs_write = std::fs::metadata(&path)
            .map(|m| m.len() != bytes.len() as u64)
            .unwrap_or(true);
        if needs_write {
            std::fs::write(&path, bytes)?;
        }
    }
    Ok(dir)
}
