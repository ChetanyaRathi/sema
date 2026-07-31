//! Deterministic workflow policy compilation and boundary matching.
//!
//! This crate is deliberately runtime-agnostic. It compiles immutable Sema maps
//! into Rust-only policy data, evaluates resolved model identities and
//! model-supplied tool arguments, and returns decisions for the workflow/LLM
//! integration layers to enforce and journal.

use globset::{GlobBuilder, GlobMatcher};
use sema_core::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use url::{Host, Url};

const POLICY_VERSION: i64 = 1;

/// A policy definition or matcher compilation error.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PolicyError {
    #[error("{0}")]
    Invalid(String),
}

/// The default effect when no explicit rule matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultEffect {
    Allow,
    Deny,
}

/// What a model gate does with a denied fallback target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ModelDenyAction {
    Skip,
    Fail,
}

/// What an agent loop does with a denied tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ToolDenyAction {
    ToolError,
    Fail,
}

/// The result of checking one policy layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyCheck {
    pub allowed: bool,
    pub rule: String,
    pub reason: Option<String>,
}

impl PolicyCheck {
    fn allow(rule: impl Into<String>) -> Self {
        Self {
            allowed: true,
            rule: rule.into(),
            reason: None,
        }
    }

    fn deny(rule: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            rule: rule.into(),
            reason: Some(reason.into()),
        }
    }
}

/// One compiled, named policy layer.
#[derive(Debug)]
pub struct CompiledPolicy {
    name: String,
    fingerprint: String,
    models: Option<ModelPolicy>,
    tools: Option<ToolPolicy>,
}

impl CompiledPolicy {
    /// Compile a `defpolicy` map or an inline policy map.
    pub fn compile(value: &Value) -> Result<Self, PolicyError> {
        let map = require_map(value, "policy")?;
        reject_unknown_keys(
            map,
            &["__policy-name", "__policy-version", "models", "tools"],
            "policy",
        )?;

        let name = get(map, "__policy-name")
            .and_then(value_name)
            .unwrap_or_else(|| "inline-policy".to_string());
        if name.trim().is_empty() {
            return Err(invalid("policy name must not be empty"));
        }

        if let Some(version) = get(map, "__policy-version") {
            let version = version
                .as_int()
                .ok_or_else(|| invalid(":__policy-version must be an integer"))?;
            if version != POLICY_VERSION {
                return Err(invalid(format!(
                    "unsupported policy version {version}; expected {POLICY_VERSION}"
                )));
            }
        }

        let models = get(map, "models").map(ModelPolicy::compile).transpose()?;
        let tools = get(map, "tools").map(ToolPolicy::compile).transpose()?;
        let fingerprint = fingerprint(value, &name);

        Ok(Self {
            name,
            fingerprint,
            models,
            tools,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Stable SHA-256 digest over the policy name, version, and canonical map.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn model_action(&self) -> ModelDenyAction {
        self.models
            .as_ref()
            .map_or(ModelDenyAction::Fail, |policy| policy.on_deny)
    }

    pub fn tool_action(&self) -> ToolDenyAction {
        self.tools
            .as_ref()
            .map_or(ToolDenyAction::Fail, |policy| policy.on_deny)
    }

    /// Check a fully resolved provider/model pair.
    pub fn check_model(&self, provider: &str, model: &str) -> PolicyCheck {
        self.models.as_ref().map_or_else(
            || PolicyCheck::allow("models.unrestricted"),
            |policy| policy.check(provider, model),
        )
    }

    /// Check a named tool and its model-supplied JSON arguments.
    pub fn check_tool(
        &self,
        tool: &str,
        arguments: &serde_json::Value,
        workspace_root: &Path,
    ) -> PolicyCheck {
        self.tools.as_ref().map_or_else(
            || PolicyCheck::allow("tools.unrestricted"),
            |policy| policy.check(tool, arguments, workspace_root),
        )
    }
}

#[derive(Debug)]
struct ModelPolicy {
    default: DefaultEffect,
    allow: Vec<ModelPattern>,
    deny: Vec<ModelPattern>,
    on_deny: ModelDenyAction,
}

impl ModelPolicy {
    fn compile(value: &Value) -> Result<Self, PolicyError> {
        let map = require_map(value, ":models")?;
        reject_unknown_keys(map, &["default", "allow", "deny", "on-deny"], ":models")?;
        Ok(Self {
            default: parse_default(get(map, "default"), ":models")?,
            allow: parse_model_patterns(get(map, "allow"), ":models :allow")?,
            deny: parse_model_patterns(get(map, "deny"), ":models :deny")?,
            on_deny: match get(map, "on-deny").and_then(value_name).as_deref() {
                None | Some("fail") => ModelDenyAction::Fail,
                Some("skip") => ModelDenyAction::Skip,
                Some(other) => {
                    return Err(invalid(format!(
                        ":models :on-deny must be :fail or :skip, got {other:?}"
                    )))
                }
            },
        })
    }

    fn check(&self, provider: &str, model: &str) -> PolicyCheck {
        if self
            .deny
            .iter()
            .any(|pattern| pattern.matches(provider, model))
        {
            return PolicyCheck::deny(
                "models.deny",
                format!("model {provider}/{model} matches a deny rule"),
            );
        }
        if self
            .allow
            .iter()
            .any(|pattern| pattern.matches(provider, model))
        {
            return PolicyCheck::allow("models.allow");
        }
        match self.default {
            DefaultEffect::Allow => PolicyCheck::allow("models.default-allow"),
            DefaultEffect::Deny => PolicyCheck::deny(
                "models.default-deny",
                format!("model {provider}/{model} is not allowlisted"),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelPattern {
    provider: String,
    model: Option<String>,
}

impl ModelPattern {
    fn parse(value: &str) -> Result<Self, PolicyError> {
        let (provider, model) = value.split_once('/').ok_or_else(|| {
            invalid(format!(
                "model rule {value:?} must use provider/model syntax"
            ))
        })?;
        if provider.is_empty() || model.is_empty() {
            return Err(invalid(format!(
                "model rule {value:?} must have a nonempty provider and model"
            )));
        }
        if provider.contains('*') {
            return Err(invalid(format!(
                "model rule {value:?} cannot wildcard the provider"
            )));
        }
        if model.contains('*') && model != "*" {
            return Err(invalid(format!(
                "model rule {value:?} only supports the provider/* wildcard"
            )));
        }
        Ok(Self {
            provider: provider.to_string(),
            model: (model != "*").then(|| model.to_string()),
        })
    }

    fn matches(&self, provider: &str, model: &str) -> bool {
        self.provider == provider && self.model.as_deref().is_none_or(|rule| rule == model)
    }
}

#[derive(Debug)]
struct ToolPolicy {
    default: DefaultEffect,
    allow: BTreeMap<String, ToolRule>,
    deny: BTreeSet<String>,
    on_deny: ToolDenyAction,
}

impl ToolPolicy {
    fn compile(value: &Value) -> Result<Self, PolicyError> {
        let map = require_map(value, ":tools")?;
        reject_unknown_keys(map, &["default", "allow", "deny", "on-deny"], ":tools")?;
        let allow = match get(map, "allow") {
            None => BTreeMap::new(),
            Some(value) => {
                let rules = require_map(value, ":tools :allow")?;
                let mut compiled = BTreeMap::new();
                for (name, rule) in rules {
                    let name = value_name(name)
                        .ok_or_else(|| invalid(":tools :allow keys must be tool names"))?;
                    if compiled.contains_key(&name) {
                        return Err(invalid(format!(
                            ":tools :allow has duplicate tool name {name:?}"
                        )));
                    }
                    compiled.insert(name.clone(), ToolRule::compile(&name, rule)?);
                }
                compiled
            }
        };
        let deny = parse_string_set(get(map, "deny"), ":tools :deny")?;
        let on_deny = match get(map, "on-deny").and_then(value_name).as_deref() {
            None | Some("fail") => ToolDenyAction::Fail,
            Some("tool-error") => ToolDenyAction::ToolError,
            Some(other) => {
                return Err(invalid(format!(
                    ":tools :on-deny must be :fail or :tool-error, got {other:?}"
                )))
            }
        };
        Ok(Self {
            default: parse_default(get(map, "default"), ":tools")?,
            allow,
            deny,
            on_deny,
        })
    }

    fn check(
        &self,
        tool: &str,
        arguments: &serde_json::Value,
        workspace_root: &Path,
    ) -> PolicyCheck {
        if self.deny.contains(tool) {
            return PolicyCheck::deny(
                format!("tools.{tool}.deny"),
                format!("tool {tool} matches an explicit deny rule"),
            );
        }
        if let Some(rule) = self.allow.get(tool) {
            return rule.check(tool, arguments, workspace_root);
        }
        match self.default {
            DefaultEffect::Allow => PolicyCheck::allow("tools.default-allow"),
            DefaultEffect::Deny => PolicyCheck::deny(
                "tools.default-deny",
                format!("tool {tool} is not allowlisted"),
            ),
        }
    }
}

#[derive(Debug, Default)]
struct ToolRule {
    constraints: Vec<ArgumentConstraint>,
}

impl ToolRule {
    fn compile(tool: &str, value: &Value) -> Result<Self, PolicyError> {
        let map = require_map(value, &format!("tool rule {tool:?}"))?;
        reject_unknown_keys(
            map,
            &["paths", "domains", "commands"],
            &format!("tool rule {tool:?}"),
        )?;
        let mut constraints = Vec::new();
        if let Some(value) = get(map, "paths") {
            constraints.extend(compile_constraints(
                value,
                "path",
                ConstraintKind::Path,
                tool,
            )?);
        }
        if let Some(value) = get(map, "domains") {
            constraints.extend(compile_constraints(
                value,
                "url",
                ConstraintKind::Domain,
                tool,
            )?);
        }
        if let Some(value) = get(map, "commands") {
            constraints.extend(compile_constraints(
                value,
                "command",
                ConstraintKind::Command,
                tool,
            )?);
        }
        Ok(Self { constraints })
    }

    fn check(
        &self,
        tool: &str,
        arguments: &serde_json::Value,
        workspace_root: &Path,
    ) -> PolicyCheck {
        let Some(arguments) = arguments.as_object() else {
            return PolicyCheck::deny(
                format!("tools.{tool}.arguments"),
                "tool arguments must be a JSON object",
            );
        };
        for constraint in &self.constraints {
            if let Err(reason) = constraint.check(arguments, workspace_root) {
                return PolicyCheck::deny(
                    format!(
                        "tools.{tool}.{}.{}",
                        constraint.kind.label(),
                        constraint.argument
                    ),
                    reason,
                );
            }
        }
        PolicyCheck::allow(format!("tools.{tool}.allow"))
    }
}

#[derive(Debug, Clone, Copy)]
enum ConstraintKind {
    Path,
    Domain,
    Command,
}

impl ConstraintKind {
    fn label(self) -> &'static str {
        match self {
            Self::Path => "paths",
            Self::Domain => "domains",
            Self::Command => "commands",
        }
    }
}

#[derive(Debug)]
struct ArgumentConstraint {
    argument: String,
    kind: CompiledConstraint,
}

impl ArgumentConstraint {
    fn check(
        &self,
        arguments: &serde_json::Map<String, serde_json::Value>,
        workspace_root: &Path,
    ) -> Result<(), String> {
        let value = arguments
            .get(&self.argument)
            .ok_or_else(|| format!("required argument {:?} is missing", self.argument))?;
        self.kind.check(value, workspace_root)
    }
}

#[derive(Debug)]
enum CompiledConstraint {
    Path(PathConstraint),
    Domain(DomainConstraint),
    Command(CommandConstraint),
}

impl CompiledConstraint {
    fn label(&self) -> &'static str {
        match self {
            Self::Path(_) => "paths",
            Self::Domain(_) => "domains",
            Self::Command(_) => "commands",
        }
    }

    fn check(&self, value: &serde_json::Value, workspace_root: &Path) -> Result<(), String> {
        match self {
            Self::Path(rule) => rule.check(value, workspace_root),
            Self::Domain(rule) => rule.check(value),
            Self::Command(rule) => rule.check(value),
        }
    }
}

#[derive(Debug)]
struct PathConstraint {
    allow: Vec<GlobMatcher>,
    deny: Vec<GlobMatcher>,
}

impl PathConstraint {
    fn compile(selector: &BTreeMap<Value, Value>) -> Result<Self, PolicyError> {
        let allow = parse_string_list(get(selector, "allow"), "path :allow")?;
        let deny = parse_string_list(get(selector, "deny"), "path :deny")?;
        if allow.is_empty() {
            return Err(invalid("path constraint requires a nonempty :allow list"));
        }
        Ok(Self {
            allow: compile_path_globs(&allow)?,
            deny: compile_path_globs(&deny)?,
        })
    }

    fn check(&self, value: &serde_json::Value, workspace_root: &Path) -> Result<(), String> {
        let path = value
            .as_str()
            .ok_or_else(|| "path argument must be a string".to_string())?;
        let relative = normalize_policy_path(workspace_root, path)?;
        if self.deny.iter().any(|pattern| pattern.is_match(&relative)) {
            return Err("path matches a deny pattern".to_string());
        }
        self.allow
            .iter()
            .any(|pattern| pattern.is_match(&relative))
            .then_some(())
            .ok_or_else(|| "path is not allowlisted".to_string())
    }
}

#[derive(Debug)]
struct DomainConstraint {
    allow: Vec<HostPattern>,
    deny: Vec<HostPattern>,
    schemes: BTreeSet<String>,
    ports: Option<BTreeSet<u16>>,
}

impl DomainConstraint {
    fn compile(selector: &BTreeMap<Value, Value>) -> Result<Self, PolicyError> {
        let allow = parse_string_list(get(selector, "allow"), "domain :allow")?
            .into_iter()
            .map(|host| HostPattern::parse(&host))
            .collect::<Result<Vec<_>, _>>()?;
        if allow.is_empty() {
            return Err(invalid("domain constraint requires a nonempty :allow list"));
        }
        let deny = parse_string_list(get(selector, "deny"), "domain :deny")?
            .into_iter()
            .map(|host| HostPattern::parse(&host))
            .collect::<Result<Vec<_>, _>>()?;
        let schemes = match get(selector, "schemes") {
            Some(value) => parse_string_list(Some(value), "domain :schemes")?
                .into_iter()
                .map(|scheme| scheme.to_ascii_lowercase())
                .collect(),
            None => BTreeSet::from(["https".to_string()]),
        };
        if schemes.is_empty() {
            return Err(invalid("domain :schemes must not be empty"));
        }
        if schemes
            .iter()
            .any(|scheme| scheme != "http" && scheme != "https")
        {
            return Err(invalid(
                "domain :schemes supports only \"http\" and \"https\"",
            ));
        }
        let ports = get(selector, "ports")
            .map(|value| {
                let values = require_seq(value, "domain :ports")?;
                values
                    .iter()
                    .map(|value| {
                        value
                            .as_int()
                            .and_then(|port| u16::try_from(port).ok())
                            .ok_or_else(|| {
                                invalid("domain :ports entries must be integers 0-65535")
                            })
                    })
                    .collect::<Result<BTreeSet<_>, _>>()
            })
            .transpose()?;
        Ok(Self {
            allow,
            deny,
            schemes,
            ports,
        })
    }

    fn check(&self, value: &serde_json::Value) -> Result<(), String> {
        let raw = value
            .as_str()
            .ok_or_else(|| "URL argument must be a string".to_string())?;
        let url = Url::parse(raw).map_err(|_| "URL argument is invalid".to_string())?;
        if !self.schemes.contains(url.scheme()) {
            return Err("URL scheme is not allowlisted".to_string());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("URL credentials are not allowed".to_string());
        }
        let host = match url.host() {
            Some(Host::Domain(domain)) => domain.to_ascii_lowercase(),
            Some(Host::Ipv4(ip)) => ip.to_string(),
            Some(Host::Ipv6(ip)) => ip.to_string(),
            None => return Err("URL must have a host".to_string()),
        };
        if let Some(ports) = &self.ports {
            let port = url
                .port_or_known_default()
                .ok_or_else(|| "URL port cannot be resolved".to_string())?;
            if !ports.contains(&port) {
                return Err("URL port is not allowlisted".to_string());
            }
        }
        if self.deny.iter().any(|pattern| pattern.matches(&host)) {
            return Err("URL host matches a deny rule".to_string());
        }
        self.allow
            .iter()
            .any(|pattern| pattern.matches(&host))
            .then_some(())
            .ok_or_else(|| "URL host is not allowlisted".to_string())
    }
}

#[derive(Debug)]
struct HostPattern {
    host: String,
    include_subdomains: bool,
}

impl HostPattern {
    fn parse(value: &str) -> Result<Self, PolicyError> {
        if value.contains("://") || value.contains('/') || value.contains('@') {
            return Err(invalid(format!(
                "domain rule {value:?} must be a hostname, not a URL"
            )));
        }
        let (host, include_subdomains) = match value.strip_prefix("*.") {
            Some(host) => (host, true),
            None => (value, false),
        };
        if host.is_empty() || host.contains('*') {
            return Err(invalid(format!(
                "domain rule {value:?} only supports a leading *. wildcard"
            )));
        }
        let host = match Host::parse(host) {
            Ok(Host::Domain(domain)) => domain.to_ascii_lowercase(),
            Ok(Host::Ipv4(ip)) => ip.to_string(),
            Ok(Host::Ipv6(ip)) => ip.to_string(),
            Err(_) => {
                return Err(invalid(format!(
                    "domain rule {value:?} must contain only a valid hostname"
                )))
            }
        };
        Ok(Self {
            host,
            include_subdomains,
        })
    }

    fn matches(&self, candidate: &str) -> bool {
        if !self.include_subdomains {
            return candidate == self.host;
        }
        candidate
            .strip_suffix(&self.host)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
    }
}

#[derive(Debug)]
struct CommandConstraint {
    allow: BTreeSet<String>,
    deny: BTreeSet<String>,
}

impl CommandConstraint {
    fn compile(selector: &BTreeMap<Value, Value>) -> Result<Self, PolicyError> {
        let allow = parse_string_set(get(selector, "allow"), "command :allow")?;
        let deny = parse_string_set(get(selector, "deny"), "command :deny")?;
        if allow.is_empty() {
            return Err(invalid(
                "command constraint requires a nonempty :allow list",
            ));
        }
        if allow
            .iter()
            .chain(deny.iter())
            .any(|command| command.contains('*') || command.contains('?') || command.contains('['))
        {
            return Err(invalid(
                "command rules are exact strings; wildcard syntax is not supported",
            ));
        }
        Ok(Self { allow, deny })
    }

    fn check(&self, value: &serde_json::Value) -> Result<(), String> {
        let command = value
            .as_str()
            .ok_or_else(|| "command argument must be a string".to_string())?;
        if self.deny.contains(command) {
            return Err("command matches an explicit deny rule".to_string());
        }
        self.allow
            .contains(command)
            .then_some(())
            .ok_or_else(|| "command is not allowlisted".to_string())
    }
}

fn compile_constraints(
    value: &Value,
    default_argument: &str,
    kind: ConstraintKind,
    tool: &str,
) -> Result<Vec<ArgumentConstraint>, PolicyError> {
    if let Some(map) = value.as_map_ref() {
        return compile_selector(map, default_argument, kind, tool).map(|rule| vec![rule]);
    }
    let values = require_seq(value, &format!("tool {tool:?} {}", kind.label()))?;
    if values.iter().all(|value| value.as_str().is_some()) {
        let selector = shorthand_selector(&values);
        return compile_selector(&selector, default_argument, kind, tool).map(|rule| vec![rule]);
    }
    values
        .iter()
        .map(|value| {
            let map = require_map(value, &format!("tool {tool:?} {} selector", kind.label()))?;
            compile_selector(map, default_argument, kind, tool)
        })
        .collect()
}

fn compile_selector(
    selector: &BTreeMap<Value, Value>,
    default_argument: &str,
    kind: ConstraintKind,
    tool: &str,
) -> Result<ArgumentConstraint, PolicyError> {
    let allowed_keys: &[&str] = match kind {
        ConstraintKind::Path | ConstraintKind::Command => &["arg", "allow", "deny"],
        ConstraintKind::Domain => &["arg", "allow", "deny", "schemes", "ports"],
    };
    reject_unknown_keys(
        selector,
        allowed_keys,
        &format!("tool {tool:?} {} selector", kind.label()),
    )?;
    let argument = get(selector, "arg")
        .map(|value| {
            value_name(value).ok_or_else(|| {
                invalid(format!(
                    "tool {tool:?} {} :arg must be a keyword or string",
                    kind.label()
                ))
            })
        })
        .transpose()?
        .unwrap_or_else(|| default_argument.to_string());
    if argument.is_empty() {
        return Err(invalid(format!(
            "tool {tool:?} {} :arg must not be empty",
            kind.label()
        )));
    }
    let kind = match kind {
        ConstraintKind::Path => CompiledConstraint::Path(PathConstraint::compile(selector)?),
        ConstraintKind::Domain => CompiledConstraint::Domain(DomainConstraint::compile(selector)?),
        ConstraintKind::Command => {
            CompiledConstraint::Command(CommandConstraint::compile(selector)?)
        }
    };
    Ok(ArgumentConstraint { argument, kind })
}

fn shorthand_selector(values: &[Value]) -> BTreeMap<Value, Value> {
    BTreeMap::from([(Value::keyword("allow"), Value::vector(values.to_vec()))])
}

fn compile_path_globs(patterns: &[String]) -> Result<Vec<GlobMatcher>, PolicyError> {
    patterns
        .iter()
        .map(|pattern| {
            validate_path_pattern(pattern)?;
            GlobBuilder::new(pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map(|glob| glob.compile_matcher())
                .map_err(|error| invalid(format!("invalid path pattern {pattern:?}: {error}")))
        })
        .collect()
}

fn validate_path_pattern(pattern: &str) -> Result<(), PolicyError> {
    if pattern.is_empty()
        || pattern.starts_with('/')
        || pattern.contains('\\')
        || pattern.contains(['[', ']', '{', '}', '?'])
    {
        return Err(invalid(format!(
            "path pattern {pattern:?} must be a relative literal/*/** pattern"
        )));
    }
    for component in pattern.split('/') {
        if component == ".." || (component.contains("**") && component != "**") {
            return Err(invalid(format!(
                "path pattern {pattern:?} has an invalid component {component:?}"
            )));
        }
    }
    Ok(())
}

fn normalize_policy_path(workspace_root: &Path, input: &str) -> Result<String, String> {
    if input.is_empty() || input.contains('\0') {
        return Err("path must be a nonempty string without NUL bytes".to_string());
    }
    let input_path = Path::new(input);
    if input_path.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }

    let root = absolute_lexical(workspace_root)?;
    let joined = normalize_lexical(&root.join(input_path));
    if !joined.starts_with(&root) {
        return Err("path escapes the workflow root".to_string());
    }
    let canonical_root = canonical_or_lexical(&root);
    let resolved = canonicalize_existing_prefix(&joined);
    if !resolved.starts_with(&canonical_root) {
        return Err("path resolves outside the workflow root".to_string());
    }
    let relative = resolved
        .strip_prefix(&canonical_root)
        .map_err(|_| "path cannot be made root-relative".to_string())?;
    Ok(relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(normalize_lexical(path));
    }
    std::env::current_dir()
        .map(|cwd| normalize_lexical(&cwd.join(path)))
        .map_err(|error| format!("cannot resolve workflow root: {error}"))
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| normalize_lexical(path))
}

fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
            break;
        };
        suffix.push(name);
        if !existing.pop() {
            break;
        }
    }
    let mut resolved = canonical_or_lexical(&existing);
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    normalize_lexical(&resolved)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn fingerprint(value: &Value, name: &str) -> String {
    let json = sema_core::value_to_json_lossy(value);
    let encoded = serde_json::to_vec(&json).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(b"sema-policy-v1\0");
    hasher.update(name.as_bytes());
    hasher.update(b"\0");
    hasher.update(encoded);
    format!("sha256:{:x}", hasher.finalize())
}

fn parse_default(value: Option<&Value>, context: &str) -> Result<DefaultEffect, PolicyError> {
    match value.and_then(value_name).as_deref() {
        None | Some("deny") => Ok(DefaultEffect::Deny),
        Some("allow") => Ok(DefaultEffect::Allow),
        Some(other) => Err(invalid(format!(
            "{context} :default must be :allow or :deny, got {other:?}"
        ))),
    }
}

fn parse_model_patterns(
    value: Option<&Value>,
    context: &str,
) -> Result<Vec<ModelPattern>, PolicyError> {
    parse_string_list(value, context)?
        .into_iter()
        .map(|value| ModelPattern::parse(&value))
        .collect()
}

fn parse_string_set(value: Option<&Value>, context: &str) -> Result<BTreeSet<String>, PolicyError> {
    parse_string_list(value, context).map(|values| values.into_iter().collect())
}

fn parse_string_list(value: Option<&Value>, context: &str) -> Result<Vec<String>, PolicyError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    require_seq(value, context)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid(format!("{context} entries must be strings")))
        })
        .collect()
}

fn require_seq(value: &Value, context: &str) -> Result<Vec<Value>, PolicyError> {
    value
        .as_seq()
        .map(|values| values.to_vec())
        .ok_or_else(|| invalid(format!("{context} must be a list or vector")))
}

fn require_map<'a>(
    value: &'a Value,
    context: &str,
) -> Result<&'a BTreeMap<Value, Value>, PolicyError> {
    value
        .as_map_ref()
        .ok_or_else(|| invalid(format!("{context} must be a map")))
}

fn get<'a>(map: &'a BTreeMap<Value, Value>, key: &str) -> Option<&'a Value> {
    map.iter().find_map(|(candidate, value)| {
        (value_name(candidate).as_deref() == Some(key)).then_some(value)
    })
}

fn value_name(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_keyword())
        .or_else(|| value.as_symbol())
}

fn reject_unknown_keys(
    map: &BTreeMap<Value, Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), PolicyError> {
    let mut seen = BTreeSet::new();
    for key in map.keys() {
        let key = value_name(key).ok_or_else(|| {
            invalid(format!(
                "{context} keys must be keywords, strings, or symbols"
            ))
        })?;
        if !allowed.contains(&key.as_str()) {
            return Err(invalid(format!("{context} has unknown key :{key}")));
        }
        if !seen.insert(key.clone()) {
            return Err(invalid(format!("{context} has duplicate key {key:?}")));
        }
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> PolicyError {
    PolicyError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn map(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
        Value::map(
            entries
                .into_iter()
                .map(|(key, value)| (Value::keyword(key), value))
                .collect(),
        )
    }

    fn strings(values: &[&str]) -> Value {
        Value::vector(values.iter().map(|value| Value::string(value)).collect())
    }

    fn named_policy(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
        let mut values: BTreeMap<Value, Value> = entries
            .into_iter()
            .map(|(key, value)| (Value::keyword(key), value))
            .collect();
        values.insert(Value::keyword("__policy-name"), Value::symbol("safe"));
        values.insert(
            Value::keyword("__policy-version"),
            Value::int(POLICY_VERSION),
        );
        Value::map(values)
    }

    #[test]
    fn model_rules_match_resolved_pairs_and_provider_wildcard() {
        let policy = CompiledPolicy::compile(&named_policy([(
            "models",
            map([
                ("allow", strings(&["openai/gpt-5", "ollama/*"])),
                ("deny", strings(&["ollama/unsafe"])),
                ("on-deny", Value::keyword("skip")),
            ]),
        )]))
        .unwrap();

        assert!(policy.check_model("openai", "gpt-5").allowed);
        assert!(policy.check_model("ollama", "qwen").allowed);
        assert!(!policy.check_model("ollama", "unsafe").allowed);
        assert!(!policy.check_model("openai", "gpt-4").allowed);
        assert_eq!(policy.model_action(), ModelDenyAction::Skip);
    }

    #[test]
    fn invalid_model_globs_are_rejected() {
        let error = CompiledPolicy::compile(&named_policy([(
            "models",
            map([("allow", strings(&["*/gpt-5"]))]),
        )]))
        .unwrap_err();
        assert!(error.to_string().contains("cannot wildcard the provider"));
    }

    #[test]
    fn present_sections_default_to_deny_and_hard_fail() {
        let policy =
            CompiledPolicy::compile(&named_policy([("models", map([])), ("tools", map([]))]))
                .unwrap();
        assert!(!policy.check_model("fake", "model").allowed);
        assert_eq!(policy.model_action(), ModelDenyAction::Fail);
        assert!(
            !policy
                .check_tool("read-file", &serde_json::json!({}), Path::new("."))
                .allowed
        );
        assert_eq!(policy.tool_action(), ToolDenyAction::Fail);
    }

    #[test]
    fn unknown_keys_are_rejected_instead_of_being_ignored() {
        let error = CompiledPolicy::compile(&named_policy([(
            "models",
            map([("alow", strings(&["fake/*"]))]),
        )]))
        .unwrap_err();
        assert!(error.to_string().contains("unknown key :alow"));
    }

    #[test]
    fn structural_string_and_symbol_keys_are_enforced() {
        let models = Value::map(BTreeMap::from([
            (Value::string("default"), Value::keyword("deny")),
            (Value::symbol("allow"), strings(&["openai/allowed-model"])),
        ]));
        let policy = Value::map(BTreeMap::from([(Value::string("models"), models)]));
        let policy = CompiledPolicy::compile(&policy).unwrap();

        assert!(policy.check_model("openai", "allowed-model").allowed);
        assert!(!policy.check_model("openai", "blocked-model").allowed);
    }

    #[test]
    fn string_constraint_keys_do_not_create_unconstrained_tool_rules() {
        let tool_rule = Value::map(BTreeMap::from([(
            Value::string("paths"),
            strings(&["safe/**"]),
        )]));
        let allow = Value::map(BTreeMap::from([(Value::string("read-file"), tool_rule)]));
        let tools = Value::map(BTreeMap::from([
            (Value::string("default"), Value::keyword("deny")),
            (Value::string("allow"), allow),
        ]));
        let policy = Value::map(BTreeMap::from([(Value::string("tools"), tools)]));
        let policy = CompiledPolicy::compile(&policy).unwrap();

        assert!(
            !policy
                .check_tool(
                    "read-file",
                    &serde_json::json!({"path":"../outside"}),
                    Path::new(".")
                )
                .allowed
        );
    }

    #[test]
    fn duplicate_normalized_keys_and_tool_names_are_rejected() {
        let duplicate_sections = Value::map(BTreeMap::from([
            (Value::keyword("models"), map([])),
            (Value::string("models"), map([])),
        ]));
        assert!(CompiledPolicy::compile(&duplicate_sections)
            .unwrap_err()
            .to_string()
            .contains("duplicate key"));

        let duplicate_tools = map([(
            "tools",
            map([(
                "allow",
                Value::map(BTreeMap::from([
                    (Value::keyword("read-file"), map([])),
                    (Value::string("read-file"), map([])),
                ])),
            )]),
        )]);
        assert!(CompiledPolicy::compile(&duplicate_tools)
            .unwrap_err()
            .to_string()
            .contains("duplicate tool name"));
    }

    #[test]
    fn tool_default_deny_and_explicit_deny_win() {
        let policy = CompiledPolicy::compile(&named_policy([(
            "tools",
            map([
                (
                    "allow",
                    Value::map(BTreeMap::from([(Value::string("read-file"), map([]))])),
                ),
                ("deny", strings(&["read-file"])),
            ]),
        )]))
        .unwrap();
        assert!(
            !policy
                .check_tool("read-file", &serde_json::json!({}), Path::new("."))
                .allowed
        );
        assert!(
            !policy
                .check_tool("write-file", &serde_json::json!({}), Path::new("."))
                .allowed
        );
    }

    #[test]
    fn shorthand_and_explicit_path_arguments_match() {
        let root = std::env::temp_dir().join(format!("sema-policy-path-{}", std::process::id()));
        fs::create_dir_all(root.join("src")).unwrap();
        let policy = CompiledPolicy::compile(&named_policy([(
            "tools",
            map([(
                "allow",
                Value::map(BTreeMap::from([
                    (
                        Value::string("read-file"),
                        map([("paths", strings(&["src/**"]))]),
                    ),
                    (
                        Value::string("copy-file"),
                        map([(
                            "paths",
                            Value::vector(vec![
                                map([
                                    ("arg", Value::keyword("source")),
                                    ("allow", strings(&["src/**"])),
                                ]),
                                map([
                                    ("arg", Value::keyword("destination")),
                                    ("allow", strings(&["tmp/**"])),
                                ]),
                            ]),
                        )]),
                    ),
                ])),
            )]),
        )]))
        .unwrap();

        assert!(
            policy
                .check_tool(
                    "read-file",
                    &serde_json::json!({"path":"src/lib.rs"}),
                    &root
                )
                .allowed
        );
        assert!(
            !policy
                .check_tool(
                    "read-file",
                    &serde_json::json!({"path":"Cargo.toml"}),
                    &root
                )
                .allowed
        );
        assert!(
            policy
                .check_tool(
                    "copy-file",
                    &serde_json::json!({"source":"src/lib.rs","destination":"tmp/lib.rs"}),
                    &root
                )
                .allowed
        );
        assert!(
            !policy
                .check_tool(
                    "copy-file",
                    &serde_json::json!({"source":"src/lib.rs"}),
                    &root
                )
                .allowed
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_traversal_and_absolute_paths_are_denied() {
        let root =
            std::env::temp_dir().join(format!("sema-policy-traversal-{}", std::process::id()));
        fs::create_dir_all(root.join("src")).unwrap();
        let rule = PathConstraint {
            allow: compile_path_globs(&["**".to_string()]).unwrap(),
            deny: Vec::new(),
        };
        assert!(rule.check(&serde_json::json!("../outside"), &root).is_err());
        assert!(rule
            .check(&serde_json::json!("/tmp/outside"), &root)
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn unix_backslash_is_not_treated_as_a_path_separator() {
        let root =
            std::env::temp_dir().join(format!("sema-policy-backslash-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(r"safe\secret"), "not in the safe directory").unwrap();
        let rule = PathConstraint {
            allow: compile_path_globs(&["safe/**".to_string()]).unwrap(),
            deny: Vec::new(),
        };

        assert!(rule
            .check(&serde_json::json!(r"safe\secret"), &root)
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_denied() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("sema-policy-symlink-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("sema-policy-outside-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        let rule = PathConstraint {
            allow: compile_path_globs(&["**".to_string()]).unwrap(),
            deny: Vec::new(),
        };
        assert!(rule
            .check(&serde_json::json!("escape/new.txt"), &root)
            .is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn domains_normalize_idna_and_reject_credentials() {
        let selector = BTreeMap::from([(
            Value::keyword("allow"),
            strings(&["münchen.de", "*.example.com"]),
        )]);
        let rule = DomainConstraint::compile(&selector).unwrap();
        assert!(rule
            .check(&serde_json::json!("https://münchen.de/a/../b"))
            .is_ok());
        assert!(rule
            .check(&serde_json::json!("https://api.example.com/v1"))
            .is_ok());
        assert!(rule
            .check(&serde_json::json!("https://example.com/v1"))
            .is_err());
        assert!(rule
            .check(&serde_json::json!("http://api.example.com/v1"))
            .is_err());
        assert!(rule
            .check(&serde_json::json!("https://u:p@api.example.com/v1"))
            .is_err());
    }

    #[test]
    fn domain_rules_reject_url_components_that_would_be_discarded() {
        for host in [
            "example.com:443",
            "example.com?tenant=other",
            "example.com#fragment",
        ] {
            let selector = BTreeMap::from([(Value::keyword("allow"), strings(&[host]))]);
            let error = DomainConstraint::compile(&selector).unwrap_err();
            assert!(
                error.to_string().contains("only a valid hostname"),
                "unexpected error for {host:?}: {error}"
            );
        }
    }

    #[test]
    fn commands_are_exact_and_wildcards_are_rejected() {
        let selector = BTreeMap::from([(
            Value::keyword("allow"),
            strings(&["cargo test", "git diff"]),
        )]);
        let rule = CommandConstraint::compile(&selector).unwrap();
        assert!(rule.check(&serde_json::json!("cargo test")).is_ok());
        assert!(rule.check(&serde_json::json!("cargo test -p x")).is_err());

        let wildcard = BTreeMap::from([(Value::keyword("allow"), strings(&["cargo test *"]))]);
        assert!(CommandConstraint::compile(&wildcard).is_err());
    }

    #[test]
    fn fingerprint_is_stable_and_includes_name() {
        let first = CompiledPolicy::compile(&named_policy([(
            "tools",
            map([("default", Value::keyword("allow"))]),
        )]))
        .unwrap();
        let second = CompiledPolicy::compile(&named_policy([(
            "tools",
            map([("default", Value::keyword("allow"))]),
        )]))
        .unwrap();
        assert_eq!(first.fingerprint(), second.fingerprint());

        let other = CompiledPolicy::compile(&map([(
            "tools",
            map([("default", Value::keyword("allow"))]),
        )]))
        .unwrap();
        assert_ne!(first.fingerprint(), other.fingerprint());
    }
}
