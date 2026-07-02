use std::borrow::Cow;

use reedline::{Prompt, PromptEditMode, PromptHistorySearch, PromptHistorySearchStatus};

use crate::colors::{enabled_stdout, GOLD, TERTIARY};

/// The REPL prompt: `sema> ` on the first line, `  ... ` for continuation lines.
pub struct SemaPrompt;

fn paint(s: &str, rgb: (u8, u8, u8)) -> Cow<'_, str> {
    if enabled_stdout() {
        Cow::Owned(format!(
            "\x1b[38;2;{};{};{}m{s}\x1b[0m",
            rgb.0, rgb.1, rgb.2
        ))
    } else {
        Cow::Borrowed(s)
    }
}

impl Prompt for SemaPrompt {
    fn render_prompt_left(&self) -> Cow<'_, str> {
        paint("sema", GOLD)
    }

    fn render_prompt_right(&self) -> Cow<'_, str> {
        Cow::Borrowed("")
    }

    fn render_prompt_indicator(&self, _mode: PromptEditMode) -> Cow<'_, str> {
        paint("> ", TERTIARY)
    }

    fn render_prompt_multiline_indicator(&self) -> Cow<'_, str> {
        paint("  ... ", TERTIARY)
    }

    fn render_prompt_history_search_indicator(
        &self,
        history_search: PromptHistorySearch,
    ) -> Cow<'_, str> {
        let prefix = match history_search.status {
            PromptHistorySearchStatus::Passing => "",
            PromptHistorySearchStatus::Failing => "failing ",
        };
        Cow::Owned(format!(
            "({prefix}reverse-search: {}) ",
            history_search.term
        ))
    }
}
