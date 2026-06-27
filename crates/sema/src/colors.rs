//! Sema-branded terminal colors.
//!
//! Values are taken from `website/.vitepress/theme/BrandGuide.vue` so the CLI,
//! REPL, and website share a single palette.

use std::io::IsTerminal;

// Brand palette (R, G, B).
pub const GOLD: (u8, u8, u8) = (200, 168, 85);
pub const AMBER: (u8, u8, u8) = (209, 154, 102);
pub const TEAL: (u8, u8, u8) = (122, 172, 184);
pub const TERRACOTTA: (u8, u8, u8) = (200, 85, 85);
pub const TERTIARY: (u8, u8, u8) = (107, 99, 84);

/// Whether stderr should receive ANSI color codes.
fn enabled() -> bool {
    std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

/// Whether stdout should receive ANSI color codes.
///
/// Used for the REPL prompt, which is rendered on stdout rather than stderr.
pub fn enabled_stdout() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

fn rgb_fg(rgb: (u8, u8, u8), s: &str) -> String {
    format!("\x1b[38;2;{};{};{}m{s}\x1b[0m", rgb.0, rgb.1, rgb.2)
}

fn rgb_bold_fg(rgb: (u8, u8, u8), s: &str) -> String {
    format!("\x1b[1;38;2;{};{};{}m{s}\x1b[0m", rgb.0, rgb.1, rgb.2)
}

pub fn red_bold(s: &str) -> String {
    if enabled() {
        rgb_bold_fg(TERRACOTTA, s)
    } else {
        s.to_string()
    }
}

pub fn yellow(s: &str) -> String {
    if enabled() {
        rgb_fg(AMBER, s)
    } else {
        s.to_string()
    }
}

pub fn cyan(s: &str) -> String {
    if enabled() {
        rgb_fg(TEAL, s)
    } else {
        s.to_string()
    }
}

pub fn dim(s: &str) -> String {
    if enabled() {
        rgb_fg(TERTIARY, s)
    } else {
        s.to_string()
    }
}
