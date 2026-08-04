//! Workflow-viewer projection and write endpoint for durable approvals.
//!
//! The viewer never invents approval state: reads go through
//! `sema_workflow::approval::list_requests`, which validates request digests and
//! decision signatures, and writes go through `decide`, which preserves the
//! protocol's immutable first-writer-wins semantics.

use std::collections::BTreeMap;
use std::io;
use std::sync::Arc;

use sema_workflow::approval::{
    self, ApprovalDecision, ApprovalDecisionKind, ApprovalRequest, ApprovalResolution,
    DecisionWrite,
};
use serde::Serialize;

use super::connect::ServerState;
use super::JsonResponse;

#[derive(Serialize)]
struct ApprovalRow<'a> {
    approval_id: &'a str,
    key: &'a str,
    phase: &'a str,
    reason: &'a str,
    preview: Option<&'a str>,
    requested_at: &'a str,
    status: &'static str,
    can_decide: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_unavailable: Option<&'static str>,
    default_actor: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<DecisionRow<'a>>,
}

#[derive(Serialize)]
struct DecisionRow<'a> {
    decision_id: &'a str,
    decision: ApprovalDecisionKind,
    actor: &'a str,
    provenance: &'a str,
    comment: Option<&'a str>,
    reason: Option<&'a str>,
    decided_at: &'a str,
}

#[derive(Debug, Default)]
struct DecisionForm {
    decision: Option<String>,
    actor: Option<String>,
    comment: Option<String>,
    reason: Option<String>,
}

pub(super) fn list_json(state: &Arc<ServerState>, run_id: &str) -> JsonResponse {
    match approval::list_requests(&state.run_dir, run_id) {
        Ok(resolutions) => json(
            "200 OK",
            &resolutions
                .iter()
                .map(|resolution| row(state, resolution))
                .collect::<Vec<_>>(),
        ),
        Err(error) => error_response(&error),
    }
}

pub(super) fn handle_decision(
    state: &Arc<ServerState>,
    run_id: &str,
    approval_id: &str,
    body: &[u8],
) -> JsonResponse {
    let Some(authority) = state.approval_authority.as_ref() else {
        return json_error(
            "409 Conflict",
            "viewer was started without an approval signing key",
        );
    };
    if !approval::durable_writes_supported() {
        return json_error(
            "501 Not Implemented",
            "durable approval writes are not supported on this platform",
        );
    }
    let form = match parse_form(body) {
        Ok(form) => form,
        Err(error) => return json_error("400 Bad Request", &error),
    };
    let kind = match form.decision.as_deref() {
        Some("approve") => ApprovalDecisionKind::Approve,
        Some("reject") => ApprovalDecisionKind::Reject,
        _ => {
            return json_error(
                "400 Bad Request",
                "decision must be either approve or reject",
            );
        }
    };
    let actor = form
        .actor
        .filter(|actor| !actor.trim().is_empty())
        .unwrap_or_else(|| authority.actor.clone());
    let comment = nonempty(form.comment);
    let reason = nonempty(form.reason);

    match approval::decide(
        &state.run_dir,
        run_id,
        approval_id,
        &authority.signing_key,
        kind,
        actor,
        "web-viewer".to_string(),
        comment,
        reason,
    ) {
        Ok(DecisionWrite::Created(_)) | Ok(DecisionWrite::AlreadyExists(_)) => {
            resolution_response(state, run_id, approval_id, "200 OK")
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            resolution_response(state, run_id, approval_id, "409 Conflict")
        }
        Err(error) => error_response(&error),
    }
}

fn parse_form(body: &[u8]) -> Result<DecisionForm, String> {
    let mut fields = BTreeMap::new();
    for (name, value) in url::form_urlencoded::parse(body) {
        let name = name.into_owned();
        if name == "view_token" {
            continue;
        }
        if !matches!(name.as_str(), "decision" | "actor" | "comment" | "reason") {
            continue;
        }
        if fields.insert(name.clone(), value.into_owned()).is_some() {
            return Err(format!("form field {name} must appear at most once"));
        }
    }
    Ok(DecisionForm {
        decision: fields.remove("decision"),
        actor: fields.remove("actor"),
        comment: fields.remove("comment"),
        reason: fields.remove("reason"),
    })
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn resolution_response(
    state: &Arc<ServerState>,
    run_id: &str,
    approval_id: &str,
    status: &'static str,
) -> JsonResponse {
    match approval::list_requests(&state.run_dir, run_id) {
        Ok(resolutions) => match resolutions
            .iter()
            .find(|resolution| request(resolution).approval_id == approval_id)
        {
            Some(resolution) => json(status, &row(state, resolution)),
            None => json_error("404 Not Found", "approval request was not found"),
        },
        Err(error) => error_response(&error),
    }
}

fn row<'a>(state: &'a ServerState, resolution: &'a ApprovalResolution) -> ApprovalRow<'a> {
    let request = request(resolution);
    let decision = match resolution {
        ApprovalResolution::Pending(_) => None,
        ApprovalResolution::Approved(_, decision) | ApprovalResolution::Rejected(_, decision) => {
            Some(decision)
        }
    };
    let status = match resolution {
        ApprovalResolution::Pending(_) => "pending",
        ApprovalResolution::Approved(_, _) => "approved",
        ApprovalResolution::Rejected(_, _) => "rejected",
    };
    let authority = state.approval_authority.as_ref();
    let can_decide = status == "pending"
        && approval::durable_writes_supported()
        && authority.is_some_and(|authority| authority.public_key == request.authority_public_key);
    let decision_unavailable = if status != "pending" || can_decide {
        None
    } else if !approval::durable_writes_supported() {
        Some("platform-unsupported")
    } else if authority.is_none() {
        Some("missing-signing-key")
    } else {
        Some("authority-mismatch")
    };
    ApprovalRow {
        approval_id: &request.approval_id,
        key: &request.key,
        phase: &request.phase,
        reason: &request.reason,
        preview: request.preview.as_deref(),
        requested_at: &request.requested_at,
        status,
        can_decide,
        decision_unavailable,
        default_actor: can_decide.then(|| authority.map_or("local-user", |value| &value.actor)),
        decision: decision.map(decision_row),
    }
}

fn request(resolution: &ApprovalResolution) -> &ApprovalRequest {
    match resolution {
        ApprovalResolution::Pending(request)
        | ApprovalResolution::Approved(request, _)
        | ApprovalResolution::Rejected(request, _) => request,
    }
}

fn decision_row(decision: &ApprovalDecision) -> DecisionRow<'_> {
    DecisionRow {
        decision_id: &decision.decision_id,
        decision: decision.decision,
        actor: &decision.actor,
        provenance: &decision.provenance,
        comment: decision.comment.as_deref(),
        reason: decision.reason.as_deref(),
        decided_at: &decision.decided_at,
    }
}

fn error_response(error: &io::Error) -> JsonResponse {
    let status = match error.kind() {
        io::ErrorKind::NotFound => "404 Not Found",
        io::ErrorKind::InvalidInput => "400 Bad Request",
        io::ErrorKind::PermissionDenied => "403 Forbidden",
        io::ErrorKind::AlreadyExists => "409 Conflict",
        io::ErrorKind::InvalidData => "422 Unprocessable Content",
        io::ErrorKind::Unsupported => "501 Not Implemented",
        _ => "500 Internal Server Error",
    };
    json_error(status, &error.to_string())
}

fn json_error(status: &'static str, message: &str) -> JsonResponse {
    json(status, &serde_json::json!({ "error": message }))
}

fn json(status: &'static str, value: &impl Serialize) -> JsonResponse {
    match serde_json::to_vec(value) {
        Ok(body) => (status, "application/json", body),
        Err(_) => (
            "500 Internal Server Error",
            "application/json",
            br#"{"error":"cannot serialize approval response"}"#.to_vec(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_form_decodes_utf8_and_rejects_duplicates() {
        let form = parse_form(
            b"decision=reject&actor=release+manager&reason=not+safe+%E2%80%94+yet&view_token=x",
        )
        .unwrap();
        assert_eq!(form.decision.as_deref(), Some("reject"));
        assert_eq!(form.actor.as_deref(), Some("release manager"));
        assert_eq!(form.reason.as_deref(), Some("not safe — yet"));
        assert!(parse_form(b"decision=approve&decision=reject").is_err());
    }
}
