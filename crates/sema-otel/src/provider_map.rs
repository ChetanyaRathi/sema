//! Sema provider name → OTel GenAI `gen_ai.provider.name` value.
//!
//! `gen_ai.*` is experimental and churns, so the mapping is isolated here. The bare
//! `gemini` value is non-conformant (mis-buckets Gemini) — map it to `gcp.gemini`.
//! Unknown providers pass through unchanged (best-effort), which is the right default
//! for OpenAI-compatible providers configured under their own name (groq, mistral_ai…).

/// Map a Sema provider name to its `gen_ai.provider.name` value (spec v1.37+).
pub fn gen_ai_provider_name(sema_provider: &str) -> &str {
    match sema_provider {
        "gemini" => "gcp.gemini",
        "vertex" => "gcp.vertex_ai",
        "mistral" => "mistral_ai",
        // openai / anthropic / ollama / groq / deepseek / perplexity / cohere / x_ai
        // already match the spec's valid set (or have no standard value — keep raw).
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gemini_to_gcp() {
        assert_eq!(gen_ai_provider_name("gemini"), "gcp.gemini");
        assert_eq!(gen_ai_provider_name("vertex"), "gcp.vertex_ai");
    }

    #[test]
    fn passes_through_conformant_names() {
        assert_eq!(gen_ai_provider_name("openai"), "openai");
        assert_eq!(gen_ai_provider_name("anthropic"), "anthropic");
        assert_eq!(gen_ai_provider_name("ollama"), "ollama");
    }
}
