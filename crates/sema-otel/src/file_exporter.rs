//! A collector-independent JSONL span exporter for `SEMA_OTEL_FILE`.
//!
//! Each finished span is written as one JSON object per line (a Sema-defined stable
//! schema), so offline capture works with no OTLP collector. Preferred over
//! `opentelemetry-stdout`, whose format is explicitly unspecified.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use opentelemetry::trace::{SpanKind, Status};
use opentelemetry::{Array, KeyValue, Value};
use opentelemetry_sdk::error::{OTelSdkError, OTelSdkResult};
use opentelemetry_sdk::trace::{SpanData, SpanExporter};

#[derive(Debug)]
pub struct JsonlFileExporter {
    writer: Mutex<BufWriter<File>>,
}

impl JsonlFileExporter {
    /// Open `path` for append (creating it if absent). Errors propagate to the caller
    /// so init can fall back to a no-op rather than panic.
    pub fn new(path: &str) -> std::io::Result<Self> {
        let file = OpenOptions::new().append(true).create(true).open(path)?;
        Ok(Self {
            writer: Mutex::new(BufWriter::new(file)),
        })
    }

    fn write_batch(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        let mut w = self
            .writer
            .lock()
            .map_err(|e| OTelSdkError::InternalFailure(format!("otel file lock poisoned: {e}")))?;
        for span in &batch {
            let mut line = serde_json::to_string(&span_to_json(span))
                .unwrap_or_else(|e| format!("{{\"error\":\"otel serialize: {e}\"}}"));
            line.push('\n');
            // Best-effort: a write failure must not crash the VM. Record it as an SDK
            // error (swallowed by the processor) rather than propagating to the script.
            if let Err(e) = w.write_all(line.as_bytes()) {
                return Err(OTelSdkError::InternalFailure(format!(
                    "otel file write failed: {e}"
                )));
            }
        }
        w.flush()
            .map_err(|e| OTelSdkError::InternalFailure(format!("otel file flush failed: {e}")))?;
        Ok(())
    }
}

impl SpanExporter for JsonlFileExporter {
    fn export(
        &self,
        batch: Vec<SpanData>,
    ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
        // All work is synchronous file I/O; there is no real await point.
        std::future::ready(self.write_batch(batch))
    }

    fn force_flush(&self) -> OTelSdkResult {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.flush();
        }
        Ok(())
    }

    fn shutdown(&self) -> OTelSdkResult {
        self.force_flush()
    }
}

fn nanos(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn kind_str(k: &SpanKind) -> &'static str {
    match k {
        SpanKind::Client => "client",
        SpanKind::Server => "server",
        SpanKind::Producer => "producer",
        SpanKind::Consumer => "consumer",
        SpanKind::Internal => "internal",
    }
}

fn value_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Bool(b) => J::Bool(*b),
        Value::I64(i) => J::from(*i),
        Value::F64(f) => J::from(*f),
        Value::String(s) => J::String(s.to_string()),
        Value::Array(a) => match a {
            Array::Bool(xs) => J::Array(xs.iter().map(|x| J::Bool(*x)).collect()),
            Array::I64(xs) => J::Array(xs.iter().map(|x| J::from(*x)).collect()),
            Array::F64(xs) => J::Array(xs.iter().map(|x| J::from(*x)).collect()),
            Array::String(xs) => J::Array(xs.iter().map(|x| J::String(x.to_string())).collect()),
            _ => J::Null,
        },
        _ => J::Null,
    }
}

fn attrs_to_json(attrs: &[KeyValue]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for kv in attrs {
        map.insert(kv.key.to_string(), value_to_json(&kv.value));
    }
    serde_json::Value::Object(map)
}

/// Serialize one span to the Sema JSONL schema. Public for the in-crate tests.
pub fn span_to_json(span: &SpanData) -> serde_json::Value {
    let status = match &span.status {
        Status::Unset => "unset".to_string(),
        Status::Ok => "ok".to_string(),
        Status::Error { description } => format!("error: {description}"),
    };
    serde_json::json!({
        "name": span.name.to_string(),
        "trace_id": format!("{:032x}", span.span_context.trace_id()),
        "span_id": format!("{:016x}", span.span_context.span_id()),
        "parent_span_id": format!("{:016x}", span.parent_span_id),
        "kind": kind_str(&span.span_kind),
        "start_unix_nano": nanos(span.start_time).to_string(),
        "end_unix_nano": nanos(span.end_time).to_string(),
        "status": status,
        "attributes": attrs_to_json(&span.attributes),
    })
}
