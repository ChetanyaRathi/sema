//! M0 acceptance: `SEMA_OTEL_FILE` + a dropped span writes one JSON line.
//! Single test in its own binary so the global-provider `Once` runs cleanly.

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn file_exporter_writes_one_json_line_per_span() {
    use std::io::Read;

    let dir = std::env::temp_dir();
    let path = dir.join(format!("sema-otel-test-{}.jsonl", std::process::id()));
    let path_str = path.to_str().unwrap().to_string();
    let _ = std::fs::remove_file(&path);

    // SAFETY: single-threaded test setup before any otel init.
    unsafe {
        std::env::set_var("SEMA_OTEL_FILE", &path_str);
        std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT");
    }

    let guard = sema_otel::init_from_env();
    assert!(guard.is_some(), "SEMA_OTEL_FILE must install a provider");

    {
        let s = sema_otel::vm_span("unit-cell");
        s.set_str("sema.test", "yes");
        drop(s);

        let llm = sema_otel::llm_span("chat");
        llm.set_dispatch("gemini", "gemini-2.5-flash");
        llm.set_response(&sema_otel::ResponseFacts {
            input_tokens: 10,
            output_tokens: 5,
            response_model: "gemini-2.5-flash".into(),
            finish_reason: Some("stop".into()),
            cost_usd: Some(0.0001),
            ..Default::default()
        });
        drop(llm);
    }

    // Drop the guard → bounded flush + shutdown.
    drop(guard);

    let mut contents = String::new();
    std::fs::File::open(&path)
        .expect("jsonl file should exist")
        .read_to_string(&mut contents)
        .unwrap();
    let _ = std::fs::remove_file(&path);

    let lines: Vec<&str> = contents.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(
        lines.len(),
        2,
        "expected one JSON line per span, got:\n{contents}"
    );

    // Each line is valid JSON with the Sema schema.
    let vm: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(vm["name"], "unit-cell");
    assert_eq!(vm["kind"], "internal");
    assert_eq!(vm["attributes"]["sema.test"], "yes");

    // The LLM span: provider mapped (gemini → gcp.gemini), name renamed, usage present.
    let llm: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(llm["name"], "chat gemini-2.5-flash");
    assert_eq!(llm["kind"], "client");
    assert_eq!(llm["attributes"]["gen_ai.provider.name"], "gcp.gemini");
    assert_eq!(llm["attributes"]["gen_ai.operation.name"], "chat");
    assert_eq!(llm["attributes"]["gen_ai.usage.input_tokens"], 10);
    assert_eq!(llm["attributes"]["gen_ai.usage.output_tokens"], 5);
    assert_eq!(
        llm["attributes"]["gen_ai.response.finish_reasons"],
        serde_json::json!(["stop"])
    );
}
