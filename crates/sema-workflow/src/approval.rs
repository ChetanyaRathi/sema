//! Durable, host-controlled approval request and decision sidecars.
//!
//! The journal reports approval events, but these atomically-published private files are
//! the authority consulted before a workflow crosses a gate. A decision is immutable and
//! bound to the exact request digest and revision.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const APPROVAL_SCHEMA_VERSION: u32 = 1;
const APPROVAL_SIDECAR_MAX_BYTES: u64 = 128 * 1024;
const APPROVAL_TEXT_MAX_CHARS: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub schema_version: u32,
    pub approval_id: String,
    pub request_digest: String,
    pub revision: u64,
    pub run_id: String,
    pub workflow: String,
    pub code_version: String,
    pub args_digest: String,
    pub phase: String,
    pub key: String,
    pub occurrence: u32,
    pub subject_digest: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub requested_at: String,
}

#[derive(Debug, Clone)]
pub struct NewApprovalRequest {
    pub run_id: String,
    pub workflow: String,
    pub code_version: String,
    pub args_digest: String,
    pub phase: String,
    pub key: String,
    pub occurrence: u32,
    pub subject_digest: String,
    pub reason: String,
    pub preview: Option<String>,
    pub requested_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecisionKind {
    Approve,
    Reject,
}

impl fmt::Display for ApprovalDecisionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Approve => "approve",
            Self::Reject => "reject",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalDecision {
    pub schema_version: u32,
    pub decision_id: String,
    pub approval_id: String,
    pub request_digest: String,
    pub request_revision: u64,
    pub decision: ApprovalDecisionKind,
    pub actor: String,
    pub provenance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub decided_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalResolution {
    Pending(ApprovalRequest),
    Approved(ApprovalRequest, ApprovalDecision),
    Rejected(ApprovalRequest, ApprovalDecision),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionWrite {
    Created(ApprovalDecision),
    AlreadyExists(ApprovalDecision),
}

impl ApprovalRequest {
    pub fn new(input: NewApprovalRequest) -> Self {
        let binding = serde_json::json!({
            "schema_version": APPROVAL_SCHEMA_VERSION,
            "revision": 1,
            "run_id": input.run_id,
            "workflow": input.workflow,
            "code_version": input.code_version,
            "args_digest": input.args_digest,
            "phase": input.phase,
            "key": input.key,
            "occurrence": input.occurrence,
            "subject_digest": input.subject_digest,
            "reason": input.reason,
            "preview": input.preview,
        });
        let request_digest = sha256_json(&binding);
        let approval_id = format!("apr_{}", &request_digest[..24]);
        Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            approval_id,
            request_digest,
            revision: 1,
            run_id: binding["run_id"].as_str().unwrap_or_default().to_string(),
            workflow: binding["workflow"].as_str().unwrap_or_default().to_string(),
            code_version: binding["code_version"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            args_digest: binding["args_digest"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            phase: binding["phase"].as_str().unwrap_or_default().to_string(),
            key: binding["key"].as_str().unwrap_or_default().to_string(),
            occurrence: binding["occurrence"].as_u64().unwrap_or_default() as u32,
            subject_digest: binding["subject_digest"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            reason: binding["reason"].as_str().unwrap_or_default().to_string(),
            preview: binding["preview"].as_str().map(str::to_string),
            requested_at: input.requested_at,
        }
    }

    pub fn validate(&self, expected_run_id: &str) -> io::Result<()> {
        if self.schema_version != APPROVAL_SCHEMA_VERSION {
            return Err(invalid_data("unsupported approval request schema version"));
        }
        if self.revision != 1 {
            return Err(invalid_data("unsupported approval request revision"));
        }
        crate::context::validate_explicit_run_id(&self.run_id)?;
        if self.run_id != expected_run_id {
            return Err(invalid_data("approval request belongs to a different run"));
        }
        for (value, label) in [
            (&self.run_id, "approval run id"),
            (&self.workflow, "approval workflow"),
            (&self.code_version, "approval code version"),
            (&self.args_digest, "approval args digest"),
            (&self.key, "approval key"),
            (&self.subject_digest, "approval subject digest"),
            (&self.reason, "approval reason"),
            (&self.requested_at, "approval request timestamp"),
        ] {
            validate_text(value, label, false)?;
        }
        validate_text(&self.phase, "approval phase", true)?;
        if let Some(preview) = &self.preview {
            validate_text(preview, "approval preview", true)?;
        }
        let rebuilt = Self::new(NewApprovalRequest {
            run_id: self.run_id.clone(),
            workflow: self.workflow.clone(),
            code_version: self.code_version.clone(),
            args_digest: self.args_digest.clone(),
            phase: self.phase.clone(),
            key: self.key.clone(),
            occurrence: self.occurrence,
            subject_digest: self.subject_digest.clone(),
            reason: self.reason.clone(),
            preview: self.preview.clone(),
            requested_at: self.requested_at.clone(),
        });
        if rebuilt.request_digest != self.request_digest || rebuilt.approval_id != self.approval_id
        {
            return Err(invalid_data(
                "approval request digest does not match its contents",
            ));
        }
        Ok(())
    }
}

impl ApprovalDecision {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        request: &ApprovalRequest,
        decision: ApprovalDecisionKind,
        actor: String,
        provenance: String,
        comment: Option<String>,
        reason: Option<String>,
        decided_at: String,
    ) -> Self {
        let binding = serde_json::json!({
            "approval_id": request.approval_id,
            "request_digest": request.request_digest,
            "request_revision": request.revision,
            "decision": decision,
            "actor": actor,
            "provenance": provenance,
            "comment": comment,
            "reason": reason,
            "decided_at": decided_at,
        });
        let decision_id = format!("dec_{}", &sha256_json(&binding)[..24]);
        Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            decision_id,
            approval_id: request.approval_id.clone(),
            request_digest: request.request_digest.clone(),
            request_revision: request.revision,
            decision,
            actor: binding["actor"].as_str().unwrap_or_default().to_string(),
            provenance: binding["provenance"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            comment: binding["comment"].as_str().map(str::to_string),
            reason: binding["reason"].as_str().map(str::to_string),
            decided_at: binding["decided_at"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        }
    }

    fn validate_for(&self, request: &ApprovalRequest) -> io::Result<()> {
        if self.schema_version != APPROVAL_SCHEMA_VERSION
            || self.approval_id != request.approval_id
            || self.request_digest != request.request_digest
            || self.request_revision != request.revision
        {
            return Err(invalid_data(
                "approval decision is not bound to this request and revision",
            ));
        }
        for (value, label) in [
            (&self.actor, "approval actor"),
            (&self.provenance, "approval provenance"),
            (&self.decided_at, "approval decision timestamp"),
        ] {
            validate_text(value, label, false)?;
        }
        if let Some(comment) = &self.comment {
            validate_text(comment, "approval comment", true)?;
        }
        if let Some(reason) = &self.reason {
            validate_text(reason, "approval reason", false)?;
        }
        if self.decision == ApprovalDecisionKind::Reject
            && self
                .reason
                .as_deref()
                .is_none_or(|reason| reason.trim().is_empty())
        {
            return Err(invalid_data("a rejection decision requires a reason"));
        }
        let rebuilt = Self::new(
            request,
            self.decision,
            self.actor.clone(),
            self.provenance.clone(),
            self.comment.clone(),
            self.reason.clone(),
            self.decided_at.clone(),
        );
        if rebuilt.decision_id != self.decision_id {
            return Err(invalid_data(
                "approval decision digest does not match its contents",
            ));
        }
        Ok(())
    }
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// SHA-256 over an ordered list of length-prefixed UTF-8 fields.
///
/// Length prefixes keep field boundaries unambiguous even when a field contains a
/// separator character. This is used for approval identity inputs, where values can
/// originate in workflow source and must not be concatenated ambiguously.
pub fn sha256_fields(fields: &[&str]) -> String {
    let mut digest = Sha256::new();
    for field in fields {
        digest.update((field.len() as u64).to_le_bytes());
        digest.update(field.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

pub fn now_timestamp() -> String {
    crate::context::rfc3339_now()
}

pub fn ensure_request(
    run_dir: &Path,
    candidate: &ApprovalRequest,
) -> io::Result<ApprovalResolution> {
    candidate.validate(&candidate.run_id)?;
    validate_component(&candidate.approval_id, "approval id")?;
    let dir = approval_dir(run_dir);
    create_private_dir(&dir)?;
    let request_path = request_path(run_dir, &candidate.approval_id);
    let request = if path_entry_exists(&request_path)? {
        let existing: ApprovalRequest = read_json(&request_path)?;
        existing.validate(&candidate.run_id)?;
        if existing.request_digest != candidate.request_digest {
            return Err(invalid_data(
                "approval id collision: existing request has a different digest",
            ));
        }
        existing
    } else {
        match publish_json_once(&request_path, candidate) {
            Ok(true) => candidate.clone(),
            Ok(false) => {
                let existing: ApprovalRequest = read_json(&request_path)?;
                existing.validate(&candidate.run_id)?;
                if existing.request_digest != candidate.request_digest {
                    return Err(invalid_data(
                        "approval request changed while it was being created",
                    ));
                }
                existing
            }
            Err(error) => return Err(error),
        }
    };

    let decision_path = decision_path(run_dir, &request.approval_id);
    if !path_entry_exists(&decision_path)? {
        return Ok(ApprovalResolution::Pending(request));
    }
    let decision: ApprovalDecision = read_json(&decision_path)?;
    decision.validate_for(&request)?;
    Ok(match decision.decision {
        ApprovalDecisionKind::Approve => ApprovalResolution::Approved(request, decision),
        ApprovalDecisionKind::Reject => ApprovalResolution::Rejected(request, decision),
    })
}

#[allow(clippy::too_many_arguments)]
pub fn decide(
    runs_root: &Path,
    run_id: &str,
    approval_id: &str,
    kind: ApprovalDecisionKind,
    actor: String,
    provenance: String,
    comment: Option<String>,
    reason: Option<String>,
) -> io::Result<DecisionWrite> {
    crate::context::validate_explicit_run_id(run_id)?;
    validate_component(approval_id, "approval id")?;
    validate_text(&actor, "approval actor", false)?;
    validate_text(&provenance, "approval provenance", false)?;
    if let Some(comment) = &comment {
        validate_text(comment, "approval comment", true)?;
    }
    if let Some(reason) = &reason {
        validate_text(reason, "approval reason", false)?;
    }
    let run_dir = runs_root.join(run_id);
    let request: ApprovalRequest = read_json(&request_path(&run_dir, approval_id))?;
    request.validate(run_id)?;
    if request.approval_id != approval_id {
        return Err(invalid_data("approval id does not match request filename"));
    }
    if kind == ApprovalDecisionKind::Reject
        && reason
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "rejecting an approval requires a reason",
        ));
    }
    let decision = ApprovalDecision::new(
        &request,
        kind,
        actor,
        provenance,
        comment,
        reason,
        now_timestamp(),
    );
    let path = decision_path(&run_dir, approval_id);
    if publish_json_once(&path, &decision)? {
        return Ok(DecisionWrite::Created(decision));
    }
    let existing: ApprovalDecision = read_json(&path)?;
    existing.validate_for(&request)?;
    if existing.decision == decision.decision {
        Ok(DecisionWrite::AlreadyExists(existing))
    } else {
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "approval already has a conflicting {} decision by {}",
                existing.decision, existing.actor
            ),
        ))
    }
}

pub fn list_requests(runs_root: &Path, run_id: &str) -> io::Result<Vec<ApprovalResolution>> {
    crate::context::validate_explicit_run_id(run_id)?;
    let run_dir = runs_root.join(run_id);
    let dir = approval_dir(&run_dir);
    let mut paths = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".request.json"))
            })
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let request: ApprovalRequest = read_json(&path)?;
            request.validate(run_id)?;
            ensure_request(&run_dir, &request)
        })
        .collect()
}

pub fn approval_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("approvals")
}

pub fn request_path(run_dir: &Path, approval_id: &str) -> PathBuf {
    approval_dir(run_dir).join(format!("{approval_id}.request.json"))
}

pub fn decision_path(run_dir: &Path, approval_id: &str) -> PathBuf {
    approval_dir(run_dir).join(format!("{approval_id}.decision.json"))
}

fn sha256_json(value: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(value).expect("approval binding is JSON serializable");
    sha256_bytes(&bytes)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_data(format!(
            "approval sidecar {} is not a regular file",
            path.display()
        )));
    }
    if metadata.len() > APPROVAL_SIDECAR_MAX_BYTES {
        return Err(invalid_data(format!(
            "approval sidecar {} exceeds {} bytes",
            path.display(),
            APPROVAL_SIDECAR_MAX_BYTES
        )));
    }
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        invalid_data(format!(
            "cannot parse approval sidecar {}: {error}",
            path.display()
        ))
    })
}

fn publish_json_once(path: &Path, value: &impl Serialize) -> io::Result<bool> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| invalid_data(format!("cannot serialize approval sidecar: {error}")))?;
    if bytes.len() as u64 + 1 > APPROVAL_SIDECAR_MAX_BYTES {
        return Err(invalid_data(format!(
            "approval sidecar exceeds {APPROVAL_SIDECAR_MAX_BYTES} bytes"
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid_data("approval sidecar has no parent directory"))?;
    create_private_dir(parent)?;
    let tmp = parent.join(format!(
        ".approval-{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("sidecar")
    ));
    let mut file = private_create_new(&tmp)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        match fs::hard_link(&tmp, path) {
            Ok(()) => {
                sync_dir(parent);
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    })();
    drop(file);
    let _ = fs::remove_file(&tmp);
    result
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_data(format!(
                "approval path {} is not a regular directory",
                path.display()
            )));
        }
    }
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_data(format!(
            "approval path {} is not a regular directory",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_create_new(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn sync_dir(path: &Path) {
    if let Ok(dir) = File::open(path) {
        let _ = dir.sync_all();
    }
}

fn validate_component(value: &str, label: &str) -> io::Result<()> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.chars().any(char::is_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} is not a safe path component"),
        ));
    }
    Ok(())
}

fn validate_text(value: &str, label: &str, allow_empty: bool) -> io::Result<()> {
    if (!allow_empty && value.trim().is_empty()) || value.chars().count() > APPROVAL_TEXT_MAX_CHARS
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{label} must {}and contain at most {APPROVAL_TEXT_MAX_CHARS} characters",
                if allow_empty { "" } else { "be nonempty " }
            ),
        ));
    }
    Ok(())
}

fn path_entry_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sema-approval-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn request_input() -> NewApprovalRequest {
        NewApprovalRequest {
            run_id: "run-1".into(),
            workflow: "release".into(),
            code_version: "code-a".into(),
            args_digest: "args-a".into(),
            phase: "publish".into(),
            key: "release-signoff".into(),
            occurrence: 0,
            subject_digest: "subject-a".into(),
            reason: "Publish release".into(),
            preview: Some("Publish package@1.0.0".into()),
            requested_at: "0".into(),
        }
    }

    fn request() -> ApprovalRequest {
        ApprovalRequest::new(request_input())
    }

    #[test]
    fn field_hash_is_boundary_safe() {
        assert_ne!(sha256_fields(&["a", "bc"]), sha256_fields(&["ab", "c"]));
        assert_ne!(sha256_fields(&["a\0b", "c"]), sha256_fields(&["a", "b\0c"]));
    }

    #[test]
    fn request_identity_tracks_execution_bindings() {
        let original = request();
        let changed_code = ApprovalRequest::new(NewApprovalRequest {
            code_version: "code-b".into(),
            ..request_input()
        });
        let changed_subject = ApprovalRequest::new(NewApprovalRequest {
            subject_digest: "subject-b".into(),
            ..request_input()
        });

        assert_ne!(original.approval_id, changed_code.approval_id);
        assert_ne!(original.approval_id, changed_subject.approval_id);
    }

    #[test]
    fn request_is_idempotent_and_decision_is_bound() {
        let root = temp_root("roundtrip");
        let run_dir = root.join("run-1");
        let request = request();
        assert!(matches!(
            ensure_request(&run_dir, &request).unwrap(),
            ApprovalResolution::Pending(_)
        ));
        assert!(matches!(
            ensure_request(&run_dir, &request).unwrap(),
            ApprovalResolution::Pending(_)
        ));
        decide(
            &root,
            "run-1",
            &request.approval_id,
            ApprovalDecisionKind::Approve,
            "alice".into(),
            "cli".into(),
            Some("looks good".into()),
            None,
        )
        .unwrap();
        assert!(matches!(
            ensure_request(&run_dir, &request).unwrap(),
            ApprovalResolution::Approved(_, _)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conflicting_decision_cannot_overwrite_the_winner() {
        let root = temp_root("conflict");
        let run_dir = root.join("run-1");
        let request = request();
        ensure_request(&run_dir, &request).unwrap();
        decide(
            &root,
            "run-1",
            &request.approval_id,
            ApprovalDecisionKind::Approve,
            "alice".into(),
            "cli".into(),
            None,
            None,
        )
        .unwrap();
        let error = decide(
            &root,
            "run-1",
            &request.approval_id,
            ApprovalDecisionKind::Reject,
            "bob".into(),
            "web".into(),
            None,
            Some("no".into()),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(matches!(
            ensure_request(&run_dir, &request).unwrap(),
            ApprovalResolution::Approved(_, _)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn racing_opposite_decisions_have_one_winner() {
        let root = temp_root("race");
        let request = request();
        ensure_request(&root.join("run-1"), &request).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles = [ApprovalDecisionKind::Approve, ApprovalDecisionKind::Reject]
            .into_iter()
            .map(|kind| {
                let root = root.clone();
                let approval_id = request.approval_id.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    decide(
                        &root,
                        "run-1",
                        &approval_id,
                        kind,
                        kind.to_string(),
                        "test".into(),
                        None,
                        (kind == ApprovalDecisionKind::Reject).then(|| "no".into()),
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let decisions = fs::read_dir(approval_dir(&root.join("run-1")))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".decision.json")
            })
            .count();
        assert_eq!(decisions, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampered_request_is_rejected() {
        let root = temp_root("tamper");
        let run_dir = root.join("run-1");
        let request = request();
        ensure_request(&run_dir, &request).unwrap();
        let path = request_path(&run_dir, &request.approval_id);
        let mut json: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        json["reason"] = serde_json::json!("changed");
        fs::write(&path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert_eq!(
            ensure_request(&run_dir, &request).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampered_revision_and_copied_decision_are_rejected() {
        let root = temp_root("binding-tamper");
        let run_dir = root.join("run-1");
        let first = request();
        let second = ApprovalRequest::new(NewApprovalRequest {
            key: "second-signoff".into(),
            ..request_input()
        });
        ensure_request(&run_dir, &first).unwrap();
        ensure_request(&run_dir, &second).unwrap();

        let first_request_path = request_path(&run_dir, &first.approval_id);
        let mut request_json: serde_json::Value =
            serde_json::from_slice(&fs::read(&first_request_path).unwrap()).unwrap();
        request_json["revision"] = serde_json::json!(2);
        fs::write(
            &first_request_path,
            serde_json::to_vec_pretty(&request_json).unwrap(),
        )
        .unwrap();
        assert_eq!(
            ensure_request(&run_dir, &first).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        fs::write(
            &first_request_path,
            serde_json::to_vec_pretty(&first).unwrap(),
        )
        .unwrap();
        decide(
            &root,
            "run-1",
            &first.approval_id,
            ApprovalDecisionKind::Approve,
            "alice".into(),
            "cli".into(),
            None,
            None,
        )
        .unwrap();
        fs::copy(
            decision_path(&run_dir, &first.approval_id),
            decision_path(&run_dir, &second.approval_id),
        )
        .unwrap();
        assert_eq!(
            ensure_request(&run_dir, &second).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampered_decision_is_rejected() {
        let root = temp_root("tampered-decision");
        let run_dir = root.join("run-1");
        let request = request();
        ensure_request(&run_dir, &request).unwrap();
        decide(
            &root,
            "run-1",
            &request.approval_id,
            ApprovalDecisionKind::Approve,
            "alice".into(),
            "cli".into(),
            None,
            None,
        )
        .unwrap();
        let path = decision_path(&run_dir, &request.approval_id);
        let mut json: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        json["actor"] = serde_json::json!("mallory");
        fs::write(&path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert_eq!(
            ensure_request(&run_dir, &request).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let _ = fs::remove_dir_all(root);
    }
}
