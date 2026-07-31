//! End-to-end tests for durable explicit workflow approvals at the CLI boundary.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NONCE: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "sema-workflow-approval-{label}-{}-{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn sema(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sema"))
        .args(args)
        .env("CI", "1")
        .output()
        .expect("run sema subprocess")
}

fn request_id(root: &Path, run_id: &str) -> String {
    let approval_dir = root.join(run_id).join("approvals");
    let request_path = fs::read_dir(&approval_dir)
        .expect("approval directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".request.json"))
        })
        .expect("request sidecar");
    serde_json::from_slice::<serde_json::Value>(&fs::read(request_path).unwrap()).unwrap()
        ["approval_id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn write_workflow(root: &Path, run_id: &str) -> (PathBuf, PathBuf, PathBuf) {
    fs::create_dir_all(root).unwrap();
    let workflow = root.join("approval.sema");
    let crossed = root.join("crossed.txt");
    let bypassed = root.join("bypassed.txt");
    let path = |path: &Path| path.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        &workflow,
        format!(
            r#"
            (defworkflow approval-demo "approval test" {{:phases ["Release"]}}
              (phase "Release")
              (checkpoint :prepared 1)
              (try
                (approval :release-signoff
                  {{:reason "Publish the release"
                    :subject {{:kind :external-action :secret "do-not-store-raw"}}
                    :preview "Publish package@1.0.0"}})
                (catch e (file/write "{}" "caught")))
              (file/write "{}" "crossed")
              {{:status :success}})
            "#,
            path(&bypassed),
            path(&crossed),
        ),
    )
    .unwrap();
    assert!(!root.join(run_id).exists());
    (workflow, crossed, bypassed)
}

#[test]
fn pending_approval_stops_then_approve_and_resume_crosses_gate() {
    let root = temp_root("approve");
    let run_id = "wf_approval_approve";
    let (workflow, crossed, bypassed) = write_workflow(&root, run_id);
    let root_s = root.to_string_lossy().to_string();
    let workflow_s = workflow.to_string_lossy().to_string();

    let pending = Command::new(env!("CARGO_BIN_EXE_sema"))
        .args([
            "workflow",
            "run",
            &workflow_s,
            "--run-dir",
            &root_s,
            "--approval-mode",
            "pause",
        ])
        .env("CI", "1")
        .env("SEMA_WORKFLOW_RUN_ID", run_id)
        .output()
        .unwrap();
    assert_eq!(pending.status.code(), Some(3), "{pending:?}");
    assert!(!crossed.exists(), "later side effect ran before approval");
    assert!(!bypassed.exists(), "try/catch bypassed the approval stop");
    let first_result: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(run_id).join("result.json")).unwrap()).unwrap();
    assert_eq!(first_result["status"], "needs-approval");
    assert_eq!(first_result["run-id"], run_id);

    let approval_id = request_id(&root, run_id);
    let request_text = fs::read_to_string(
        root.join(run_id)
            .join("approvals")
            .join(format!("{approval_id}.request.json")),
    )
    .unwrap();
    assert!(!request_text.contains("do-not-store-raw"));
    assert!(request_text.contains("Publish package@1.0.0"));

    let approved = sema(&[
        "workflow",
        "approve",
        run_id,
        &approval_id,
        "--run-dir",
        &root_s,
        "--actor",
        "test-operator",
        "--comment",
        "verified",
    ]);
    assert!(approved.status.success(), "{approved:?}");

    let resumed = sema(&[
        "workflow",
        "run",
        &workflow_s,
        "--run-dir",
        &root_s,
        "--resume",
        run_id,
        "--approval-mode",
        "pause",
    ]);
    assert!(resumed.status.success(), "{resumed:?}");
    assert_eq!(fs::read_to_string(&crossed).unwrap(), "crossed");
    assert!(!bypassed.exists());

    let events = fs::read_to_string(root.join(run_id).join("events.resume-1.jsonl")).unwrap();
    assert!(events.contains(r#""event":"approval.granted""#));
    assert!(events.contains(r#""event":"approval.applied""#));

    let listed = sema(&[
        "workflow",
        "approvals",
        run_id,
        "--run-dir",
        &root_s,
        "--json",
    ]);
    assert!(listed.status.success(), "{listed:?}");
    let list: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(list[0]["status"], "approved");
    assert_eq!(list[0]["decision"]["actor"], "test-operator");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn pending_approval_in_parallel_propagates_before_later_workflow_forms() {
    let root = temp_root("parallel");
    fs::create_dir_all(&root).unwrap();
    let run_id = "wf_approval_parallel";
    let workflow = root.join("parallel-approval.sema");
    let crossed = root.join("parallel-crossed.txt");
    let crossed_literal = serde_json::to_string(&crossed.to_string_lossy()).unwrap();
    fs::write(
        &workflow,
        format!(
            r#"
            (defworkflow approval-parallel "parallel approval test" {{:phases ["Release"]}}
              (phase "Release")
              (parallel
                (list
                  (fn ()
                    (approval :parallel-signoff
                      {{:reason "Approve the parallel release"
                        :subject {{:kind :release :target "production"}}}}))))
              (file/write {crossed_literal} "crossed")
              {{:status :success}})
            "#
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_sema"))
        .args([
            "workflow",
            "run",
            &workflow.to_string_lossy(),
            "--run-dir",
            &root.to_string_lossy(),
            "--approval-mode",
            "pause",
        ])
        .env("CI", "1")
        .env("SEMA_WORKFLOW_RUN_ID", run_id)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert!(
        !crossed.exists(),
        "a later workflow form ran after a parallel approval gate"
    );
    let result: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(run_id).join("result.json")).unwrap()).unwrap();
    assert_eq!(result["status"], "needs-approval");
    let _ = request_id(&root, run_id);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejected_approval_resumes_to_rejected_without_crossing_gate() {
    let root = temp_root("reject");
    let run_id = "wf_approval_reject";
    let (workflow, crossed, bypassed) = write_workflow(&root, run_id);
    let root_s = root.to_string_lossy().to_string();
    let workflow_s = workflow.to_string_lossy().to_string();
    let pending = Command::new(env!("CARGO_BIN_EXE_sema"))
        .args([
            "workflow",
            "run",
            &workflow_s,
            "--run-dir",
            &root_s,
            "--approval-mode",
            "pause",
        ])
        .env("CI", "1")
        .env("SEMA_WORKFLOW_RUN_ID", run_id)
        .output()
        .unwrap();
    assert_eq!(pending.status.code(), Some(3));
    let approval_id = request_id(&root, run_id);

    let rejected = sema(&[
        "workflow",
        "reject",
        run_id,
        &approval_id,
        "--run-dir",
        &root_s,
        "--actor",
        "reviewer",
        "--reason",
        "release is not ready",
    ]);
    assert!(rejected.status.success(), "{rejected:?}");
    let resumed = sema(&[
        "workflow",
        "run",
        &workflow_s,
        "--run-dir",
        &root_s,
        "--resume",
        run_id,
        "--approval-mode",
        "pause",
    ]);
    assert_eq!(resumed.status.code(), Some(1), "{resumed:?}");
    assert!(!crossed.exists());
    assert!(!bypassed.exists(), "try/catch bypassed a rejection");
    let result: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(run_id).join("result.json")).unwrap()).unwrap();
    assert_eq!(result["status"], "rejected");
    assert_eq!(result["reason"], "release is not ready");
    let events = fs::read_to_string(root.join(run_id).join("events.resume-1.jsonl")).unwrap();
    assert!(events.contains(r#""event":"approval.rejected""#));
    assert!(!events.contains(r#""event":"approval.applied""#));

    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn terminal_auto_mode_prompts_approves_and_resumes_inline() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let root = temp_root("terminal-prompt");
    let run_id = "wf_approval_terminal";
    let (workflow, crossed, bypassed) = write_workflow(&root, run_id);
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open approval prompt pty");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_sema"));
    command.args([
        "workflow",
        "run",
        &workflow.to_string_lossy(),
        "--run-dir",
        &root.to_string_lossy(),
        "--approval-mode",
        "auto",
    ]);
    command.env("CI", "");
    command.env("TERM", "xterm-256color");
    command.env("SEMA_WORKFLOW_RUN_ID", run_id);
    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("spawn approval prompt");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("clone pty reader");
    let mut writer = pair.master.take_writer().expect("take pty writer");
    let (send_chunk, receive_chunk) = mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) if send_chunk.send(chunk[..read].to_vec()).is_err() => break,
                Ok(_) => {}
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !String::from_utf8_lossy(&output).contains("Approve?") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            panic!(
                "approval prompt did not appear: {}",
                String::from_utf8_lossy(&output)
            );
        }
        output.extend(
            receive_chunk
                .recv_timeout(remaining)
                .unwrap_or_else(|error| panic!("read approval prompt: {error}")),
        );
    }
    writer.write_all(b"y\n").expect("approve in terminal");
    writer.flush().expect("flush terminal approval");
    let status = child.wait().expect("wait for approval workflow");
    drop(writer);
    let _ = reader_thread.join();

    assert!(
        status.success(),
        "interactive workflow failed: {}",
        String::from_utf8_lossy(&output)
    );
    assert_eq!(fs::read_to_string(crossed).unwrap(), "crossed");
    assert!(!bypassed.exists());
    let approval_id = request_id(&root, run_id);
    let decision: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.join(run_id)
                .join("approvals")
                .join(format!("{approval_id}.decision.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(decision["decision"], "approve");
    assert_eq!(decision["provenance"], "terminal-prompt");

    let _ = fs::remove_dir_all(root);
}
