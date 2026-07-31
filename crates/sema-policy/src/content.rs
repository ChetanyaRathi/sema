//! Shared deterministic secret and personal-data scanners.

use regex::Regex;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// Maximum text size accepted by policy content scanners.
pub const INPUT_BYTE_CAP: usize = 16 * 1024 * 1024;

/// A deterministic detector exposed by the policy DSL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DetectorKind {
    Secret,
    Email,
    Phone,
    Ipv4,
    PaymentCard,
}

impl DetectorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Email => "email",
            Self::Phone => "phone",
            Self::Ipv4 => "ipv4",
            Self::PaymentCard => "payment-card",
        }
    }
}

/// One private scanner finding. Callers must not serialize the matched span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub label: &'static str,
    pub start: usize,
    pub end: usize,
}

/// Scan one detector family and return non-overlapping byte spans.
pub fn scan(text: &str, detector: DetectorKind) -> Vec<Finding> {
    match detector {
        DetectorKind::Secret => detect_secrets(text),
        DetectorKind::Email => detect_regex(text, "email", email_re()),
        DetectorKind::Phone => detect_regex(text, "phone", phone_re()),
        DetectorKind::Ipv4 => detect_regex(text, "ipv4", ipv4_re()),
        DetectorKind::PaymentCard => detect_payment_cards(text),
    }
}

/// Scan the public PII detector set used by `pii/detect`.
pub fn detect_pii(text: &str) -> Vec<Finding> {
    merge_findings(
        [DetectorKind::Email, DetectorKind::Ipv4, DetectorKind::Phone]
            .into_iter()
            .flat_map(|detector| scan(text, detector)),
    )
}

/// Run all deterministic secret matchers.
pub fn detect_secrets(text: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    for (regex, label) in [
        (aws_re(), "aws-access-key"),
        (private_key_re(), "private-key"),
        (jwt_re(), "jwt"),
        (slack_re(), "slack-token"),
        (github_re(), "github-token"),
    ] {
        for matched in regex.find_iter(text) {
            push_if_free(&mut findings, label, matched.start(), matched.end());
        }
    }
    for captures in generic_re().captures_iter(text) {
        let whole = captures
            .get(0)
            .expect("generic secret regex has whole match");
        let value = captures
            .get(2)
            .expect("generic secret regex has value capture");
        if shannon_entropy(value.as_str()) >= ENTROPY_THRESHOLD {
            push_if_free(&mut findings, "api-key", whole.start(), whole.end());
        }
    }
    for matched in high_entropy_re().find_iter(text) {
        if shannon_entropy(matched.as_str()) >= ENTROPY_THRESHOLD {
            push_if_free(
                &mut findings,
                "high-entropy",
                matched.start(),
                matched.end(),
            );
        }
    }
    findings.sort_by_key(|finding| finding.start);
    findings
}

/// Replace findings right-to-left with deterministic typed markers.
pub fn redact(text: &str, findings: &[Finding]) -> String {
    let mut findings = findings.to_vec();
    findings.sort_by_key(|finding| finding.start);
    let mut accepted = Vec::new();
    let mut last_end = 0;
    for finding in findings {
        if finding.start >= last_end {
            last_end = finding.end;
            accepted.push(finding);
        }
    }
    let mut output = text.to_string();
    for finding in accepted.into_iter().rev() {
        output.replace_range(
            finding.start..finding.end,
            &format!("«redacted:{}»", finding.label),
        );
    }
    output
}

fn detect_regex(text: &str, label: &'static str, regex: &Regex) -> Vec<Finding> {
    regex
        .find_iter(text)
        .map(|matched| Finding {
            label,
            start: matched.start(),
            end: matched.end(),
        })
        .collect()
}

fn detect_payment_cards(text: &str) -> Vec<Finding> {
    payment_card_re()
        .find_iter(text)
        .filter(|matched| {
            let digits: String = matched
                .as_str()
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            (13..=19).contains(&digits.len()) && luhn_valid(&digits)
        })
        .map(|matched| Finding {
            label: "payment-card",
            start: matched.start(),
            end: matched.end(),
        })
        .collect()
}

fn luhn_valid(digits: &str) -> bool {
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(index, byte)| {
            let mut digit = u32::from(byte - b'0');
            if index % 2 == 1 {
                digit *= 2;
                if digit > 9 {
                    digit -= 9;
                }
            }
            digit
        })
        .sum();
    sum % 10 == 0
}

fn merge_findings(findings: impl IntoIterator<Item = Finding>) -> Vec<Finding> {
    let mut merged = Vec::new();
    for finding in findings {
        push_if_free(&mut merged, finding.label, finding.start, finding.end);
    }
    merged.sort_by_key(|finding| finding.start);
    merged
}

fn push_if_free(findings: &mut Vec<Finding>, label: &'static str, start: usize, end: usize) {
    if findings
        .iter()
        .any(|finding| start < finding.end && finding.start < end)
    {
        return;
    }
    findings.push(Finding { label, start, end });
}

fn shannon_entropy(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    let mut counts = BTreeMap::new();
    for character in value.chars() {
        *counts.entry(character).or_insert(0usize) += 1;
    }
    let length = value.chars().count() as f64;
    counts.values().fold(0.0, |entropy, count| {
        let probability = *count as f64 / length;
        entropy - probability * probability.log2()
    })
}

const ENTROPY_THRESHOLD: f64 = 3.5;

fn aws_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"AKIA[0-9A-Z]{16}").expect("valid AWS regex"))
}

fn generic_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})"#)
            .expect("valid generic secret regex")
    })
}

fn private_key_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").expect("valid private-key regex")
    })
}

fn jwt_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").expect("valid JWT regex")
    })
}

fn slack_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"xox[baprs]-[A-Za-z0-9-]+").expect("valid Slack regex"))
}

fn github_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"gh[pousr]_[A-Za-z0-9]{36,}").expect("valid GitHub token regex")
    })
}

fn high_entropy_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"[A-Za-z0-9+/=_\-]{32,}").expect("valid high-entropy regex"))
}

fn email_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").expect("valid email regex")
    })
}

fn ipv4_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\b",
        )
        .expect("valid IPv4 regex")
    })
}

fn phone_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}")
            .expect("valid phone regex")
    })
}

fn payment_card_re() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\b(?:[0-9][ -]?){12,18}[0-9]\b").expect("valid payment-card regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_cards_require_luhn_validation() {
        assert_eq!(
            scan("card 4111 1111 1111 1111", DetectorKind::PaymentCard).len(),
            1
        );
        assert!(scan("card 4111 1111 1111 1112", DetectorKind::PaymentCard).is_empty());
    }

    #[test]
    fn redaction_is_typed_and_idempotent() {
        let text = "contact me@example.com";
        let findings = scan(text, DetectorKind::Email);
        let redacted = redact(text, &findings);
        assert_eq!(redacted, "contact «redacted:email»");
        assert_eq!(
            redact(&redacted, &scan(&redacted, DetectorKind::Email)),
            redacted
        );
    }
}
