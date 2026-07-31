//! End-to-end workflow policy tests.
//!
//! These use the real workflow, LLM, agent, tool, journal, and resume paths
//! against a deterministic `FakeProvider`. No network access or API key is
//! required.

use crate::workflow_common as wc;
use crate::workflow_common::{run_workflow, temp_run_dir, RunOpts};

use sema_eval::Interpreter;
use sema_llm::fake::FakeProvider;
use sema_llm::types::ToolCall;

fn fake_with_reply(text: &str) -> FakeProvider {
    FakeProvider::builder("fake")
        .model("fake-model")
        .reply(text)
        .build()
}

#[test]
fn workflow_policy_allows_the_resolved_model_and_journals_the_check() {
    let src = r#"
        (defpolicy safe
          {:models {:default :deny :allow ["fake/fake-model"]}})
        (defworkflow guarded "model allowlist" {:policy safe}
          (phase "Run")
          (def result (step "say hello" {:name "writer"}))
          {:status :success :result result})
    "#;

    let out = wc::run_once(src, fake_with_reply("hello"), "wf_policy_model_allow");
    assert_eq!(out.result["status"], "success");
    assert_eq!(out.recorder.call_count(), 1);

    let checks = wc::events_of(&out.events, "policy.checked");
    assert_eq!(
        checks.len(),
        1,
        "one provider boundary must produce one policy check"
    );
    assert!(
        checks.iter().any(|event| {
            event["policy"] == "safe"
                && event["boundary"] == "model"
                && event["subject"] == "fake/fake-model"
                && event["rule"] == "models.allow"
        }),
        "expected the resolved provider/model check, got {checks:?}"
    );
}

#[test]
fn model_skip_still_fails_a_non_fallback_call_before_provider_access() {
    let src = r#"
        (defpolicy safe
          {:models {:default :deny
                    :allow ["other/*"]
                    :on-deny :skip}})
        (defworkflow guarded "model deny" {:policy safe}
          (phase "Run")
          (step "must not run" {:name "writer"})
          {:status :success})
    "#;

    let out = wc::run_once(src, fake_with_reply("unexpected"), "wf_policy_model_deny");
    assert_eq!(
        out.recorder.call_count(),
        0,
        "a denied model must not reach the provider"
    );
    let violations = wc::events_of(&out.events, "policy.violation");
    assert!(
        violations.iter().any(|event| {
            event["boundary"] == "model"
                && event["subject"] == "fake/fake-model"
                && event["action"] == "fail"
        }),
        "expected a model violation, got {violations:?}"
    );
    assert_eq!(
        wc::events_of(&out.events, "run.ended")[0]["status"],
        "failed"
    );
}

#[test]
fn model_skip_skips_only_denied_fallback_targets() {
    let src = r#"
        (llm/define-provider :blocked
          {:default-model "model"
           :complete (lambda (_request) "blocked")})
        (llm/define-provider :allowed
          {:default-model "model"
           :complete (lambda (_request) "allowed")})
        (defpolicy fallback-safe
          {:models {:default :deny
                    :allow ["allowed/model"]
                    :on-deny :skip}})
        (defworkflow guarded "fallback skip" {:policy fallback-safe}
          (phase "Run")
          (def result
            (llm/with-fallback [:blocked :allowed]
              (lambda () (llm/complete "choose"))))
          {:status :success :result result})
    "#;

    let fake = FakeProvider::builder("fake").model("fake-model").build();
    let out = wc::run_once(src, fake, "wf_policy_fallback_skip");
    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["result"], "allowed");
    assert!(
        wc::events_of(&out.events, "policy.violation")
            .iter()
            .any(|event| { event["subject"] == "blocked/model" && event["action"] == "skip" }),
        "the denied fallback should be skipped and audited"
    );
    assert!(wc::events_of(&out.events, "policy.checked")
        .iter()
        .any(|event| event["subject"] == "allowed/model"));
}

#[test]
fn single_entry_fallback_preserves_skip_for_completion_and_stream() {
    let src = r#"
        (defpolicy fallback-safe
          {:models {:default :deny :on-deny :skip}})
        (defworkflow guarded "single fallback skip" {:policy fallback-safe}
          (phase "Run")
          (def completion-type
            (try
              (llm/with-fallback [:fake]
                (lambda () (llm/complete "complete")))
              (catch error (:type error))))
          (def stream-type
            (try
              (llm/with-fallback [:fake]
                (lambda ()
                  (llm/stream "stream" (lambda (_chunk) nil))))
              (catch error (:type error))))
          {:status :success
           :types (list completion-type stream-type)})
    "#;

    let fake = FakeProvider::builder("fake").model("fake-model").build();
    let out = wc::run_once(src, fake, "wf_policy_single_fallback_skip");
    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["types"], serde_json::json!(["llm", "llm"]));
    assert_eq!(
        out.recorder.call_count(),
        0,
        "a denied fallback target must not reach the provider"
    );

    let violations = wc::events_of(&out.events, "policy.violation");
    assert_eq!(
        violations.len(),
        2,
        "completion and stream should each audit one denial"
    );
    assert!(
        violations
            .iter()
            .all(|event| { event["subject"] == "fake/fake-model" && event["action"] == "skip" }),
        "a one-entry fallback must retain fallback skip behavior: {violations:?}"
    );
}

#[test]
fn batch_and_pmap_check_model_policy_before_provider_access() {
    let src = r#"
        (defpolicy locked {:models {:default :deny}})
        (defworkflow guarded "batch model policy" {:policy locked}
          (phase "Run")
          (def batch-result
            (try
              (llm/batch (list "batch"))
              (catch _ :denied)))
          (def pmap-result
            (try
              (llm/pmap str (list "pmap"))
              (catch _ :denied)))
          {:status :success
           :results (list batch-result pmap-result)})
    "#;

    let out = wc::run_once(
        src,
        FakeProvider::builder("fake")
            .model("fake-model")
            .reply("unexpected")
            .reply("unexpected")
            .build(),
        "wf_policy_batch_pmap",
    );
    assert_eq!(out.result["status"], "success");
    assert_eq!(
        out.result["results"],
        serde_json::json!(["denied", "denied"])
    );
    assert_eq!(
        out.recorder.call_count(),
        0,
        "denied batch requests must not reach the provider"
    );

    let violations = wc::events_of(&out.events, "policy.violation");
    assert_eq!(
        violations.len(),
        2,
        "llm/batch and llm/pmap should each audit one denial"
    );
    assert!(
        violations
            .iter()
            .all(|event| { event["subject"] == "fake/fake-model" && event["action"] == "fail" }),
        "batch model denials should be hard failures: {violations:?}"
    );
}

#[test]
fn stream_embed_and_rerank_are_denied_before_provider_or_callback() {
    let base = temp_run_dir("policy-model-surfaces");
    let marker = base.join("stream-callback");
    let path = marker
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let src = format!(
        r#"
        (defpolicy locked {{:models {{:default :deny}}}})
        (defworkflow guarded "all model surfaces" {{:policy locked}}
          (phase "Run")
          (def embed-result
            (try (llm/embed "secret") (catch _ :denied)))
          (def rerank-result
            (try (llm/rerank "query" (list "document"))
                 (catch _ :denied)))
          (def stream-result
            (try
              (llm/stream "secret"
                (lambda (chunk) (file/write "{path}" chunk)))
              (catch _ :denied)))
          {{:status :success
            :results (list embed-result rerank-result stream-result)}})
        "#
    );
    let fake = FakeProvider::builder("fake")
        .model("fake-model")
        .embed(vec![vec![0.1, 0.2]])
        .rerank(&[(0, 0.9)])
        .stream(&["must", "not", "stream"])
        .build();
    let out = run_workflow(
        &src,
        fake,
        RunOpts::fresh("wf_policy_model_surfaces", &base),
    );

    assert_eq!(out.result["status"], "success");
    assert_eq!(out.recorder.call_count(), 0, "stream must not open");
    assert!(out.recorder.embeds().is_empty(), "embed must not dispatch");
    assert!(
        out.recorder.reranks().is_empty(),
        "rerank must not dispatch"
    );
    assert!(
        !marker.exists(),
        "stream callbacks must not run for a denied model"
    );
    assert!(
        wc::events_of(&out.events, "policy.violation").len() >= 3,
        "each denied model surface should be audited"
    );

    let _ = std::fs::remove_dir_all(&base);
}

const BATCH_TOOLS: &str = r#"
    (deftool allowed-tool
      "Write a marker"
      {:path {:type :string}}
      (lambda (path) (file/write path "allowed")))
    (deftool blocked-tool
      "Write a marker that must never execute"
      {:path {:type :string}}
      (lambda (path) (file/write path "blocked")))
"#;

fn batched_tool_provider(path: &str) -> FakeProvider {
    FakeProvider::builder("fake")
        .model("fake-model")
        .tool_calls(vec![
            ToolCall {
                id: "allowed_1".into(),
                name: "allowed-tool".into(),
                arguments: serde_json::json!({"path": path}),
                thought_signature: None,
            },
            ToolCall {
                id: "blocked_1".into(),
                name: "blocked-tool".into(),
                arguments: serde_json::json!({"path": path}),
                thought_signature: None,
            },
        ])
        .reply("finished")
        .build()
}

fn batch_workflow(action: &str) -> String {
    format!(
        r#"
        {BATCH_TOOLS}
        (defpolicy safe
          {{:models {{:default :deny :allow ["fake/fake-model"]}}
            :tools {{:default :deny
                     :allow {{"allowed-tool" {{}}}}
                     :deny ["blocked-tool"]
                     :on-deny :{action}}}}})
        (defworkflow guarded "tool batch" {{:policy safe}}
          (phase "Run")
          (def result
            (step "use both tools"
              {{:name "coder" :tools [allowed-tool blocked-tool]}}))
          {{:status :success :result result}})
        "#
    )
}

#[test]
fn hard_tool_denial_preflights_the_batch_and_runs_no_sibling() {
    let base = temp_run_dir("policy-tool-fail");
    let marker = base.join("allowed-marker");
    let src = batch_workflow("fail");
    let out = run_workflow(
        &src,
        batched_tool_provider(marker.to_string_lossy().as_ref()),
        RunOpts::fresh("wf_policy_tool_fail", &base),
    );

    assert!(
        !marker.exists(),
        "hard denial must prevent an allowed sibling handler from running"
    );
    assert_eq!(
        wc::events_of(&out.events, "agent.tool_call").len(),
        0,
        "preflight failure happens before tool callbacks"
    );
    let violations = wc::events_of(&out.events, "policy.violation");
    assert!(
        violations
            .iter()
            .any(|event| event["subject"] == "blocked-tool" && event["action"] == "fail"),
        "expected blocked-tool violation, got {violations:?}"
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn tool_error_denial_runs_allowed_siblings_without_journaling_denied_call() {
    let base = temp_run_dir("policy-tool-error");
    let marker = base.join("allowed-marker");
    let src = batch_workflow("tool-error");
    let out = run_workflow(
        &src,
        batched_tool_provider(marker.to_string_lossy().as_ref()),
        RunOpts::fresh("wf_policy_tool_error", &base),
    );

    assert!(
        marker.exists(),
        "the allowed sibling should run under :tool-error"
    );
    assert_eq!(out.result["status"], "success");
    let tool_calls = wc::events_of(&out.events, "agent.tool_call");
    assert_eq!(
        tool_calls.len(),
        1,
        "only the allowed call reaches the observer"
    );
    assert_eq!(tool_calls[0]["tool_name"], "allowed-tool");
    assert!(wc::events_of(&out.events, "policy.violation")
        .iter()
        .any(|event| { event["subject"] == "blocked-tool" && event["action"] == "tool-error" }));

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn direct_tool_invoke_is_gated_before_the_handler() {
    let base = temp_run_dir("policy-direct-tool");
    let marker = base.join("direct-marker");
    let path = marker
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let src = format!(
        r#"
        (deftool direct-tool
          "Write a marker"
          {{:path {{:type :string}}}}
          (lambda (path) (file/write path "ran")))
        (defpolicy safe
          {{:tools {{:default :deny :on-deny :tool-error}}}})
        (defworkflow guarded "direct tool" {{:policy safe}}
          (phase "Run")
          (tool/invoke direct-tool {{:path "{path}"}})
          {{:status :success}})
        "#
    );
    let fake = FakeProvider::builder("fake").model("fake-model").build();
    let out = run_workflow(&src, fake, RunOpts::fresh("wf_policy_direct_tool", &base));

    assert!(
        !marker.exists(),
        "direct tool policy denial must happen before its handler"
    );
    assert_eq!(
        wc::events_of(&out.events, "run.ended")[0]["status"],
        "failed"
    );
    assert!(wc::events_of(&out.events, "policy.violation")
        .iter()
        .any(|event| {
            event["subject"] == "direct-tool"
                && event["boundary"] == "tool"
                && event["action"] == "fail"
        }));

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn semantic_tool_subjects_are_name_and_argument_independent() {
    let src = r#"
        (deftool arbitrary-reader
          "read through a deployment-specific argument"
          {:location {:type :string}}
          {:policy-subjects [{:kind :file-read :path-arg :location}]}
          (fn (_location) "read-ok"))
        (deftool arbitrary-writer
          "write through a deployment-specific argument"
          {:destination {:type :string}}
          {:policy-subjects [{:kind :file-write :path-arg :destination}]}
          (fn (_destination) "write-ran"))
        (defpolicy readonly
          {:subjects
           {:default :deny
            :allow [{:kind :file-read :paths ["src/**"]}]}})
        (defworkflow guarded "semantic subjects" {:policy readonly}
          (def read-result
            (tool/invoke arbitrary-reader {:location "src/lib.rs"}))
          (def write-result
            (try
              (tool/invoke arbitrary-writer {:destination "src/lib.rs"})
              (catch error (:type error))))
          {:status :success
           :read read-result
           :write write-result
           :subjects (tool/policy-subjects arbitrary-reader)})
    "#;

    let out = wc::run_once(
        src,
        fake_with_reply("unused"),
        "wf_policy_semantic_subjects",
    );
    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["read"], "read-ok");
    assert_eq!(out.result["write"], "policy-denied");
    assert_eq!(out.result["subjects"][0]["kind"], "file-read");
    assert_eq!(out.result["subjects"][0]["path-arg"], "location");
}

#[test]
fn step_policy_can_tighten_but_not_loosen_the_workflow_policy() {
    let src = r#"
        (defpolicy workflow-safe
          {:models {:default :deny :allow ["fake/*"]}})
        (defworkflow guarded "logical AND"
          {:policy workflow-safe}
          (phase "Run")
          (step "must not run"
            {:name "writer"
             :policy {:models {:default :deny :allow ["other/*"]}}})
          {:status :success})
    "#;

    let out = wc::run_once(src, fake_with_reply("unexpected"), "wf_policy_step_tighten");
    assert_eq!(out.recorder.call_count(), 0);
    assert!(
        wc::events_of(&out.events, "policy.checked")
            .iter()
            .any(|event| event["policy"] == "workflow-safe"),
        "the outer layer should allow before the inner layer denies"
    );
    assert!(
        wc::events_of(&out.events, "policy.violation")
            .iter()
            .any(|event| event["policy"] == "inline-policy"),
        "the step layer should deny the same boundary"
    );
}

#[test]
fn workflow_policy_sequence_composes_without_loosening() {
    let src = r#"
        (defpolicy models
          {:models {:default :deny :allow ["fake/fake-model"]}})
        (defpolicy tools
          {:tools {:default :deny}})
        (defworkflow guarded "composed policy" {:policy [models tools]}
          (phase "Run")
          (llm/complete "hello"))
    "#;

    let out = wc::run_once(src, fake_with_reply("ok"), "wf_policy_sequence_composes");
    assert_eq!(out.result["status"], "success");
    assert!(out
        .events
        .iter()
        .any(|event| event["event"] == "policy.checked" && event["policy"] == "models"));
}

#[test]
fn workflow_policy_sequence_rejects_empty_and_nonmap_layers() {
    for (suffix, policy) in [("empty", "[]"), ("nonmap", "[{:models {}} 42]")] {
        let src = format!(
            r#"
                (defworkflow guarded "invalid composed policy" {{:policy {policy}}}
                  :unreachable)
            "#
        );
        let error = Interpreter::new()
            .eval_str_compiled(&src)
            .expect_err("invalid policy sequence");
        assert!(
            error.to_string().contains("invalid workflow policy"),
            "{suffix}: {error}"
        );
    }
}

#[test]
fn stricter_layer_action_is_the_effective_journaled_action() {
    let src = r#"
        (defpolicy outer
          {:models {:default :deny :on-deny :skip}})
        (defworkflow guarded "strictest action wins" {:policy outer}
          (phase "Run")
          (step "must not run"
            {:name "writer"
             :policy {:models {:default :deny :on-deny :fail}}})
          {:status :success})
    "#;

    let out = wc::run_once(src, fake_with_reply("unexpected"), "wf_policy_strictest");
    assert_eq!(out.recorder.call_count(), 0);
    let violations = wc::events_of(&out.events, "policy.violation");
    assert_eq!(violations.len(), 2, "both denying layers are journaled");
    assert!(
        violations.iter().all(|event| event["action"] == "fail"),
        "the effective hard-fail action should be visible on every violation: {violations:?}"
    );
}

#[test]
fn lexical_bypass_is_audited_and_does_not_call_the_denied_gate() {
    let src = r#"
        (defpolicy locked
          {:models {:default :deny}})
        (defworkflow guarded "trusted exception" {:policy locked}
          (phase "Run")
          (def result
            (policy/without "legacy migration fixture"
              (step "read the fixture" {:name "migrator"})))
          {:status :success :result result})
    "#;

    let out = wc::run_once(src, fake_with_reply("legacy"), "wf_policy_bypass");
    assert_eq!(out.result["status"], "success");
    assert_eq!(out.recorder.call_count(), 1);
    let bypassed = wc::events_of(&out.events, "policy.bypassed");
    assert!(
        bypassed.iter().any(|event| {
            event["boundary"] == "model"
                && event["reason"] == "legacy migration fixture"
                && event["rule"] == "policy.without"
        }),
        "expected an audited model bypass, got {bypassed:?}"
    );
}

#[test]
fn changing_only_policy_invalidates_a_resumed_step_memo() {
    let base = temp_run_dir("policy-resume");
    let first = r#"
        (defpolicy safe
          {:models {:default :deny :allow ["fake/fake-model"]}})
        (defworkflow guarded "resume policy" {:policy safe}
          (phase "Run")
          (def result (step "summarize" {:name "writer"}))
          {:status :success :result result})
    "#;
    let second = r#"
        (defpolicy safe
          {:models {:default :deny :allow ["fake/*"]}})
        (defworkflow guarded "resume policy" {:policy safe}
          (phase "Run")
          (def result (step "summarize" {:name "writer"}))
          {:status :success :result result})
    "#;

    let first_run = run_workflow(
        first,
        fake_with_reply("same answer"),
        RunOpts::fresh("wf_policy_resume", &base),
    );
    assert_eq!(first_run.recorder.call_count(), 1);

    let resumed = run_workflow(
        second,
        fake_with_reply("same answer"),
        RunOpts {
            run_id: "wf_policy_resume",
            run_dir: &base,
            resume: true,
            code_version: "",
            args_json: "{}",
        },
    );
    assert_eq!(
        resumed.recorder.call_count(),
        1,
        "a changed effective policy must miss the prior step memo"
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cassette_replay_rechecks_the_recorded_provider_identity() {
    let base = temp_run_dir("policy-cassette");
    let tape = base.join("policy-tape.jsonl");
    let tape_path = tape
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let src = format!(
        r#"
        (defpolicy safe
          {{:models {{:default :deny :allow ["fake/m"]}}}})
        (defworkflow guarded "cassette policy" {{:policy safe}}
          (phase "Run")
          (def result
            (llm/with-cassette "{tape_path}" {{:mode :record}}
              (lambda () (llm/complete "prompt" {{:model "m"}}))))
          {{:status :success :result result}})
        "#
    );
    let recorded = run_workflow(
        &src,
        FakeProvider::builder("fake")
            .model("m")
            .reply("recorded")
            .build(),
        RunOpts::fresh("wf_policy_cassette_record", &base),
    );
    assert_eq!(recorded.result["status"], "success");

    let tape_body = std::fs::read_to_string(&tape).expect("recorded policy tape");
    assert!(
        tape_body.contains(r#""provider":"fake""#),
        "policy-safe replay requires the serving provider on tape: {tape_body}"
    );
    std::fs::write(
        &tape,
        tape_body.replace(r#""provider":"fake""#, r#""provider":"other""#),
    )
    .unwrap();

    let replay_src = src.replace(":mode :record", ":mode :replay");
    let replay = run_workflow(
        &replay_src,
        FakeProvider::builder("fake")
            .model("m")
            .error(sema_llm::types::LlmError::Api {
                status: 500,
                message: "provider must not be called".into(),
            })
            .build(),
        RunOpts::fresh("wf_policy_cassette_replay", &base),
    );
    assert_eq!(replay.recorder.call_count(), 0);
    assert_eq!(
        wc::events_of(&replay.events, "run.ended")[0]["status"],
        "failed"
    );
    assert!(
        wc::events_of(&replay.events, "policy.violation")
            .iter()
            .any(|event| {
                event["subject"] == "other/m"
                    && event["source"] == "cassette"
                    && event["action"] == "fail"
            }),
        "the tampered recorded provider must be rejected before replay"
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn cassette_replay_uses_the_recorded_provider_not_the_current_route() {
    let base = temp_run_dir("policy-cassette-route");
    let tape = base.join("policy-route-tape.jsonl");
    let tape_path = tape
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let src = format!(
        r#"
        (llm/define-provider :allowed
          {{:default-model "model"
            :complete (lambda (_request) "recorded")}})
        (llm/define-provider :blocked
          {{:default-model "model"
            :complete (lambda (_request) "must not run")}})
        (defpolicy replay-safe
          {{:models {{:default :deny :allow ["allowed/model"]}}}})
        (defworkflow guarded "cassette route" {{:policy replay-safe}}
          (phase "Run")
          (def recorded
            (llm/with-fallback [:allowed]
              (lambda ()
                (llm/with-cassette "{tape_path}" {{:mode :record}}
                  (lambda () (llm/complete "prompt" {{:model "model"}}))))))
          (def replayed
            (llm/with-fallback [:blocked]
              (lambda ()
                (llm/with-cassette "{tape_path}" {{:mode :replay}}
                  (lambda () (llm/complete "prompt" {{:model "model"}}))))))
          {{:status :success :recorded recorded :replayed replayed}})
        "#
    );
    let fake = FakeProvider::builder("fake").model("fake-model").build();
    let out = run_workflow(
        &src,
        fake,
        RunOpts::fresh("wf_policy_cassette_route", &base),
    );

    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["recorded"], "recorded");
    assert_eq!(out.result["replayed"], "recorded");
    let checks = wc::events_of(&out.events, "policy.checked");
    assert_eq!(
        checks
            .iter()
            .filter(|event| event["subject"] == "allowed/model")
            .count(),
        2,
        "record and replay should each check the provider they use"
    );
    assert!(
        !checks
            .iter()
            .any(|event| event["subject"] == "blocked/model"),
        "the replay route does not serve the recorded response"
    );

    let _ = std::fs::remove_dir_all(&base);
}
