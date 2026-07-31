//! Durable, host-controlled approval request and decision sidecars.
//!
//! The journal reports approval events, but these atomically-published private files are
//! the authority consulted before a workflow crosses a gate. A decision is immutable and
//! bound to the exact request digest and revision.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{self, KeyPair as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const APPROVAL_SCHEMA_VERSION: u32 = 2;
const APPROVAL_SIDECAR_MAX_BYTES: u64 = 128 * 1024;
const APPROVAL_TEXT_MAX_CHARS: usize = 1024;

/// Host-held Ed25519 authority used to sign immutable approval decisions. The private
/// PKCS#8 bytes are deliberately opaque to Sema values and request sidecars.
#[derive(Clone)]
pub struct ApprovalSigningKey {
    pkcs8: Vec<u8>,
}

impl fmt::Debug for ApprovalSigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApprovalSigningKey(<redacted>)")
    }
}

impl ApprovalSigningKey {
    pub fn generate() -> io::Result<Self> {
        let bytes = signature::Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| invalid_data("cannot generate Ed25519 approval signing key"))?;
        Ok(Self {
            pkcs8: bytes.as_ref().to_vec(),
        })
    }

    pub fn from_base64(encoded: &str) -> io::Result<Self> {
        let pkcs8 = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| invalid_data("approval signing key is not valid base64"))?;
        signature::Ed25519KeyPair::from_pkcs8(&pkcs8)
            .map_err(|_| invalid_data("approval signing key is not valid Ed25519 PKCS#8"))?;
        Ok(Self { pkcs8 })
    }

    pub fn to_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(&self.pkcs8)
    }

    pub fn public_key_base64(&self) -> io::Result<String> {
        let pair = self.key_pair()?;
        Ok(base64::engine::general_purpose::STANDARD.encode(pair.public_key().as_ref()))
    }

    fn key_pair(&self) -> io::Result<signature::Ed25519KeyPair> {
        signature::Ed25519KeyPair::from_pkcs8(&self.pkcs8)
            .map_err(|_| invalid_data("approval signing key is not valid Ed25519 PKCS#8"))
    }

    fn sign(&self, message: &[u8]) -> io::Result<String> {
        Ok(base64::engine::general_purpose::STANDARD
            .encode(self.key_pair()?.sign(message).as_ref()))
    }
}

fn validate_public_key(encoded: &str) -> io::Result<Vec<u8>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| invalid_data("approval public key is not valid base64"))?;
    if bytes.len() != 32 {
        return Err(invalid_data(
            "approval public key must be a 32-byte Ed25519 key",
        ));
    }
    Ok(bytes)
}

pub fn normalize_public_key_base64(encoded: &str) -> io::Result<String> {
    let bytes = validate_public_key(encoded)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub schema_version: u32,
    pub approval_id: String,
    pub identity_digest: String,
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
    pub authority_public_key: String,
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
    pub authority_public_key: String,
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
    pub signature: String,
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
        let identity = RequestIdentityBinding::from(&input);
        let identity_digest = sha256_binding(&identity);
        let approval_id = format!("apr_{}", &identity_digest[..24]);
        let request_digest = sha256_binding(&RequestBinding {
            identity_digest: &identity_digest,
            requested_at: &input.requested_at,
            authority_public_key: &input.authority_public_key,
        });
        Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            approval_id,
            identity_digest,
            request_digest,
            revision: 1,
            run_id: input.run_id,
            workflow: input.workflow,
            code_version: input.code_version,
            args_digest: input.args_digest,
            phase: input.phase,
            key: input.key,
            occurrence: input.occurrence,
            subject_digest: input.subject_digest,
            reason: input.reason,
            preview: input.preview,
            requested_at: input.requested_at,
            authority_public_key: input.authority_public_key,
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
            (&self.authority_public_key, "approval authority public key"),
        ] {
            validate_text(value, label, false)?;
        }
        validate_text(&self.phase, "approval phase", true)?;
        if let Some(preview) = &self.preview {
            validate_text(preview, "approval preview", true)?;
        }
        validate_public_key(&self.authority_public_key)?;
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
            authority_public_key: self.authority_public_key.clone(),
        });
        if rebuilt.identity_digest != self.identity_digest
            || rebuilt.request_digest != self.request_digest
            || rebuilt.approval_id != self.approval_id
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
        signing_key: &ApprovalSigningKey,
        decision: ApprovalDecisionKind,
        actor: String,
        provenance: String,
        comment: Option<String>,
        reason: Option<String>,
        decided_at: String,
    ) -> io::Result<Self> {
        if signing_key.public_key_base64()? != request.authority_public_key {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "approval signing key does not match the request authority",
            ));
        }
        let binding = DecisionBinding {
            schema_version: APPROVAL_SCHEMA_VERSION,
            approval_id: &request.approval_id,
            request_digest: &request.request_digest,
            request_revision: request.revision,
            decision,
            actor: &actor,
            provenance: &provenance,
            comment: comment.as_deref(),
            reason: reason.as_deref(),
            decided_at: &decided_at,
        };
        let binding_bytes = binding_bytes(&binding);
        let signature = signing_key.sign(&binding_bytes)?;
        let decision_id = format!(
            "dec_{}",
            &sha256_fields(&[&sha256_bytes(&binding_bytes), &signature])[..24]
        );
        Ok(Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            decision_id,
            approval_id: request.approval_id.clone(),
            request_digest: request.request_digest.clone(),
            request_revision: request.revision,
            decision,
            actor,
            provenance,
            comment,
            reason,
            decided_at,
            signature,
        })
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
        let binding = DecisionBinding::from(self);
        let binding_bytes = binding_bytes(&binding);
        let public_key = validate_public_key(&request.authority_public_key)?;
        let signature = base64::engine::general_purpose::STANDARD
            .decode(&self.signature)
            .map_err(|_| invalid_data("approval decision signature is not valid base64"))?;
        signature::UnparsedPublicKey::new(&signature::ED25519, public_key)
            .verify(&binding_bytes, &signature)
            .map_err(|_| invalid_data("approval decision signature is invalid"))?;
        let expected_id = format!(
            "dec_{}",
            &sha256_fields(&[&sha256_bytes(&binding_bytes), &self.signature])[..24]
        );
        if expected_id != self.decision_id {
            return Err(invalid_data(
                "approval decision digest does not match its contents",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct RequestIdentityBinding<'a> {
    schema_version: u32,
    revision: u64,
    run_id: &'a str,
    workflow: &'a str,
    code_version: &'a str,
    args_digest: &'a str,
    phase: &'a str,
    key: &'a str,
    occurrence: u32,
    subject_digest: &'a str,
    reason: &'a str,
    preview: Option<&'a str>,
}

impl<'a> From<&'a NewApprovalRequest> for RequestIdentityBinding<'a> {
    fn from(value: &'a NewApprovalRequest) -> Self {
        Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            revision: 1,
            run_id: &value.run_id,
            workflow: &value.workflow,
            code_version: &value.code_version,
            args_digest: &value.args_digest,
            phase: &value.phase,
            key: &value.key,
            occurrence: value.occurrence,
            subject_digest: &value.subject_digest,
            reason: &value.reason,
            preview: value.preview.as_deref(),
        }
    }
}

#[derive(Serialize)]
struct RequestBinding<'a> {
    identity_digest: &'a str,
    requested_at: &'a str,
    authority_public_key: &'a str,
}

#[derive(Serialize)]
struct DecisionBinding<'a> {
    schema_version: u32,
    approval_id: &'a str,
    request_digest: &'a str,
    request_revision: u64,
    decision: ApprovalDecisionKind,
    actor: &'a str,
    provenance: &'a str,
    comment: Option<&'a str>,
    reason: Option<&'a str>,
    decided_at: &'a str,
}

impl<'a> From<&'a ApprovalDecision> for DecisionBinding<'a> {
    fn from(value: &'a ApprovalDecision) -> Self {
        Self {
            schema_version: value.schema_version,
            approval_id: &value.approval_id,
            request_digest: &value.request_digest,
            request_revision: value.request_revision,
            decision: value.decision,
            actor: &value.actor,
            provenance: &value.provenance,
            comment: value.comment.as_deref(),
            reason: value.reason.as_deref(),
            decided_at: &value.decided_at,
        }
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
        if existing.identity_digest != candidate.identity_digest
            || existing.authority_public_key != candidate.authority_public_key
        {
            return Err(invalid_data(
                "approval id collision: existing request has a different identity or authority",
            ));
        }
        existing
    } else {
        match publish_json_once(&request_path, candidate) {
            Ok(true) => candidate.clone(),
            Ok(false) => {
                let existing: ApprovalRequest = read_json(&request_path)?;
                existing.validate(&candidate.run_id)?;
                if existing.identity_digest != candidate.identity_digest
                    || existing.authority_public_key != candidate.authority_public_key
                {
                    return Err(invalid_data(
                        "approval request identity or authority changed while it was being created",
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
    signing_key: &ApprovalSigningKey,
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
        signing_key,
        kind,
        actor,
        provenance,
        comment,
        reason,
        now_timestamp(),
    )?;
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
        Ok(entries) => {
            let mut paths = Vec::new();
            for entry in entries {
                let path = entry?.path();
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".request.json"))
                {
                    paths.push(path);
                }
            }
            paths
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let request: ApprovalRequest = read_json(&path)?;
            request.validate(run_id)?;
            let expected_name = format!("{}.request.json", request.approval_id);
            if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
                return Err(invalid_data(format!(
                    "approval request filename does not match {}",
                    request.approval_id
                )));
            }
            read_resolution(&run_dir, request)
        })
        .collect()
}

fn read_resolution(run_dir: &Path, request: ApprovalRequest) -> io::Result<ApprovalResolution> {
    let path = decision_path(run_dir, &request.approval_id);
    if !path_entry_exists(&path)? {
        return Ok(ApprovalResolution::Pending(request));
    }
    let decision: ApprovalDecision = read_json(&path)?;
    decision.validate_for(&request)?;
    Ok(match decision.decision {
        ApprovalDecisionKind::Approve => ApprovalResolution::Approved(request, decision),
        ApprovalDecisionKind::Reject => ApprovalResolution::Rejected(request, decision),
    })
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

fn binding_bytes(value: &impl Serialize) -> Vec<u8> {
    // All protocol bindings are fixed Rust structs. Their declared field order — not a
    // serde_json map's feature-dependent ordering — is the wire format hashed/signed.
    serde_json::to_vec(value).expect("approval binding is JSON serializable")
}

fn sha256_binding(value: &impl Serialize) -> String {
    sha256_bytes(&binding_bytes(value))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<T> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
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
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(APPROVAL_SIDECAR_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > APPROVAL_SIDECAR_MAX_BYTES {
        return Err(invalid_data(format!(
            "approval sidecar {} exceeds {} bytes",
            path.display(),
            APPROVAL_SIDECAR_MAX_BYTES
        )));
    }
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
                sync_dir(parent)?;
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

#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_data(format!(
                "approval path {} is not a regular directory",
                path.display()
            )));
        }
    }
    if !path_entry_exists(path)? {
        let parent = path
            .parent()
            .ok_or_else(|| invalid_data("approval directory has no parent"))?;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)?;
        sync_dir(parent)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_data(format!(
            "approval path {} is not a regular directory",
            path.display()
        )));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "durable approvals require a platform implementation that can enforce private ACLs",
    ))
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

fn sync_dir(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
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

// Approval storage intentionally fails closed on non-Unix platforms until a
// private-directory ACL implementation is available there.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, OnceLock};

    fn test_key() -> ApprovalSigningKey {
        static KEY: OnceLock<ApprovalSigningKey> = OnceLock::new();
        KEY.get_or_init(|| ApprovalSigningKey::generate().unwrap())
            .clone()
    }

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
            authority_public_key: test_key().public_key_base64().unwrap(),
        }
    }

    fn request() -> ApprovalRequest {
        ApprovalRequest::new(request_input())
    }

    fn run_dir(root: &Path) -> PathBuf {
        let path = root.join("run-1");
        fs::create_dir_all(&path).unwrap();
        path
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
    fn request_timestamp_changes_full_digest_but_not_lookup_identity() {
        let original = request();
        let later = ApprovalRequest::new(NewApprovalRequest {
            requested_at: "later".into(),
            ..request_input()
        });
        assert_eq!(original.approval_id, later.approval_id);
        assert_eq!(original.identity_digest, later.identity_digest);
        assert_ne!(original.request_digest, later.request_digest);
    }

    #[test]
    fn a_different_private_key_cannot_decide_the_request() {
        let root = temp_root("wrong-key");
        let request = request();
        ensure_request(&run_dir(&root), &request).unwrap();
        let wrong = ApprovalSigningKey::generate().unwrap();
        let error = decide(
            &root,
            "run-1",
            &request.approval_id,
            &wrong,
            ApprovalDecisionKind::Approve,
            "mallory".into(),
            "test".into(),
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(matches!(
            ensure_request(&root.join("run-1"), &request).unwrap(),
            ApprovalResolution::Pending(_)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn listing_is_read_only_and_rejects_a_misnamed_request() {
        let root = temp_root("misnamed");
        let directory = run_dir(&root);
        let request = request();
        ensure_request(&directory, &request).unwrap();
        let original = request_path(&directory, &request.approval_id);
        let misnamed = approval_dir(&directory).join("apr_wrong.request.json");
        fs::rename(&original, &misnamed).unwrap();

        assert_eq!(
            list_requests(&root, "run-1").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(
            !original.exists(),
            "listing must not recreate request files"
        );
        assert!(misnamed.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sidecar_symlinks_are_never_followed() {
        use std::os::unix::fs::symlink;

        let root = temp_root("sidecar-symlink");
        let directory = run_dir(&root);
        let request = request();
        ensure_request(&directory, &request).unwrap();
        let original = request_path(&directory, &request.approval_id);
        let moved = approval_dir(&directory).join("saved-request.json");
        fs::rename(&original, &moved).unwrap();
        symlink(&moved, &original).unwrap();

        assert!(ensure_request(&directory, &request).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn request_is_idempotent_and_decision_is_bound() {
        let root = temp_root("roundtrip");
        let run_dir = run_dir(&root);
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
            &test_key(),
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
        let run_dir = run_dir(&root);
        let request = request();
        ensure_request(&run_dir, &request).unwrap();
        decide(
            &root,
            "run-1",
            &request.approval_id,
            &test_key(),
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
            &test_key(),
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
        ensure_request(&run_dir(&root), &request).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles = [ApprovalDecisionKind::Approve, ApprovalDecisionKind::Reject]
            .into_iter()
            .map(|kind| {
                let root = root.clone();
                let approval_id = request.approval_id.clone();
                let barrier = Arc::clone(&barrier);
                let signing_key = test_key();
                std::thread::spawn(move || {
                    barrier.wait();
                    decide(
                        &root,
                        "run-1",
                        &approval_id,
                        &signing_key,
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
        let run_dir = run_dir(&root);
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
        let run_dir = run_dir(&root);
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
            &test_key(),
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
        let run_dir = run_dir(&root);
        let request = request();
        ensure_request(&run_dir, &request).unwrap();
        decide(
            &root,
            "run-1",
            &request.approval_id,
            &test_key(),
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
