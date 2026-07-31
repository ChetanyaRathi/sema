//! Deterministic, provider-neutral workflow evidence bundles.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
struct Evidence {
    schema_version: u32,
    run_id: String,
    status: Option<String>,
    metadata: serde_json::Value,
    result: serde_json::Value,
    event_counts: BTreeMap<String, usize>,
    events: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct Manifest {
    schema_version: u32,
    run_id: String,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Serialize)]
struct ManifestFile {
    path: String,
    bytes: usize,
    sha256: String,
}

pub struct ExportedEvidence {
    pub directory: PathBuf,
    pub evidence_json: PathBuf,
    pub evidence_markdown: PathBuf,
    pub manifest_json: PathBuf,
}

pub fn export(
    runs_root: &Path,
    run_id: &str,
    output_directory: Option<&Path>,
) -> io::Result<ExportedEvidence> {
    validate_run_id(run_id)?;
    let run_directory = runs_root.join(run_id);
    if !run_directory.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("workflow run not found: {}", run_directory.display()),
        ));
    }
    let output_directory = output_directory
        .map(Path::to_path_buf)
        .unwrap_or_else(|| run_directory.join("evidence"));
    fs::create_dir_all(&output_directory)?;

    let metadata = read_json_or_null(&run_directory.join("metadata.json"))?;
    let result = read_json_or_null(&run_directory.join("result.json"))?;
    let journal_paths = journal_paths(&run_directory)?;
    let mut events = Vec::new();
    let mut event_counts = BTreeMap::new();
    for path in &journal_paths {
        for line in fs::read_to_string(path)?.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let event: serde_json::Value = serde_json::from_str(line).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{}: {error}", path.display()),
                )
            })?;
            if let Some(kind) = event.get("event").and_then(serde_json::Value::as_str) {
                *event_counts.entry(kind.to_string()).or_insert(0) += 1;
            }
            events.push(event);
        }
    }
    let status = result
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let evidence = Evidence {
        schema_version: 1,
        run_id: run_id.to_string(),
        status,
        metadata,
        result,
        event_counts,
        events,
    };

    let evidence_json = output_directory.join("evidence.json");
    let evidence_markdown = output_directory.join("evidence.md");
    let manifest_json = output_directory.join("manifest.json");
    let json_bytes = serde_json::to_vec_pretty(&evidence).map_err(io::Error::other)?;
    fs::write(&evidence_json, &json_bytes)?;
    let markdown = render_markdown(&evidence);
    fs::write(&evidence_markdown, markdown.as_bytes())?;

    let mut manifest_sources = vec![
        run_directory.join("metadata.json"),
        run_directory.join("result.json"),
    ];
    manifest_sources.extend(journal_paths);
    manifest_sources.push(evidence_json.clone());
    manifest_sources.push(evidence_markdown.clone());
    let files = manifest_sources
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| manifest_file(&path, &run_directory, &output_directory))
        .collect::<io::Result<Vec<_>>>()?;
    let manifest = Manifest {
        schema_version: 1,
        run_id: run_id.to_string(),
        files,
    };
    fs::write(
        &manifest_json,
        serde_json::to_vec_pretty(&manifest).map_err(io::Error::other)?,
    )?;

    Ok(ExportedEvidence {
        directory: output_directory,
        evidence_json,
        evidence_markdown,
        manifest_json,
    })
}

fn validate_run_id(run_id: &str) -> io::Result<()> {
    let mut components = Path::new(run_id).components();
    let valid = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && run_id != "."
        && run_id != "..";
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "run id must be exactly one safe path component",
        ))
    }
}

fn read_json_or_null(path: &Path) -> io::Result<serde_json::Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{}: {error}", path.display()),
            )
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(error) => Err(error),
    }
}

fn journal_paths(run_directory: &Path) -> io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let primary = run_directory.join("events.jsonl");
    if primary.is_file() {
        paths.push(primary);
    }
    let mut resumes = fs::read_dir(run_directory)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("events.resume-") && name.ends_with(".jsonl"))
        })
        .collect::<Vec<_>>();
    resumes.sort_by_key(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.strip_prefix("events.resume-"))
            .and_then(|number| number.parse::<u64>().ok())
            .unwrap_or(u64::MAX)
    });
    paths.extend(resumes);
    Ok(paths)
}

fn render_markdown(evidence: &Evidence) -> String {
    let mut markdown = format!(
        "# Workflow evidence\n\n- Run: `{}`\n- Status: `{}`\n- Events: {}\n\n## Event counts\n\n| Event | Count |\n| --- | ---: |\n",
        evidence.run_id,
        evidence.status.as_deref().unwrap_or("unknown"),
        evidence.events.len()
    );
    for (event, count) in &evidence.event_counts {
        markdown.push_str(&format!("| `{event}` | {count} |\n"));
    }
    markdown.push_str(
        "\nThe machine-readable bundle is `evidence.json`; file integrity is recorded in `manifest.json`.\n",
    );
    markdown
}

fn manifest_file(
    path: &Path,
    run_directory: &Path,
    output_directory: &Path,
) -> io::Result<ManifestFile> {
    let bytes = fs::read(path)?;
    let display = path
        .strip_prefix(run_directory)
        .or_else(|_| path.strip_prefix(output_directory))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ManifestFile {
        path: display,
        bytes: bytes.len(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sema-workflow-evidence-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn rejects_path_like_run_ids() {
        assert!(validate_run_id("../run").is_err());
        assert!(validate_run_id("nested/run").is_err());
        assert!(validate_run_id("run-1").is_ok());
    }

    #[test]
    fn exports_ordered_events_and_integrity_manifest() {
        let root = test_directory("bundle");
        let _ = fs::remove_dir_all(&root);
        let run = root.join("run-1");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("metadata.json"), r#"{"name":"demo"}"#).unwrap();
        fs::write(run.join("result.json"), r#"{"status":"success"}"#).unwrap();
        fs::write(
            run.join("events.jsonl"),
            "{\"event\":\"run.started\",\"seq\":1}\n",
        )
        .unwrap();
        fs::write(
            run.join("events.resume-1.jsonl"),
            "{\"event\":\"checkpoint\",\"seq\":2}\n",
        )
        .unwrap();

        let bundle = export(&root, "run-1", None).unwrap();
        let evidence: serde_json::Value =
            serde_json::from_slice(&fs::read(&bundle.evidence_json).unwrap()).unwrap();
        assert_eq!(evidence["status"], "success");
        assert_eq!(evidence["event_counts"]["run.started"], 1);
        assert_eq!(evidence["event_counts"]["checkpoint"], 1);
        assert_eq!(evidence["events"][0]["seq"], 1);
        assert_eq!(evidence["events"][1]["seq"], 2);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&bundle.manifest_json).unwrap()).unwrap();
        let files = manifest["files"].as_array().unwrap();
        let evidence_entry = files
            .iter()
            .find(|entry| entry["path"] == "evidence/evidence.json")
            .unwrap();
        let evidence_bytes = fs::read(&bundle.evidence_json).unwrap();
        assert_eq!(
            evidence_entry["sha256"],
            format!("{:x}", Sha256::digest(&evidence_bytes))
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
