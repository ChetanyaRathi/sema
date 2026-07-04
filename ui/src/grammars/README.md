# Vendored grammars

`sema.tmLanguage.json` is a **copy** of the canonical TextMate grammar, which
now lives in the VS Code extension repo:

    sema-lisp/vscode-sema — syntaxes/sema.tmLanguage.json

It is vendored here so `@sema/ui` can bundle it for in-browser Shiki highlighting
without reaching across package boundaries. The same copy convention is used by
`website/.vitepress/` and `pkg/` (each keeps its own vendored copy).

**Keep it in sync.** When the canonical grammar changes upstream, re-copy it:

    curl -fsSL https://raw.githubusercontent.com/sema-lisp/vscode-sema/main/syntaxes/sema.tmLanguage.json \
      -o src/grammars/sema.tmLanguage.json

The Shiki integration (`src/lib/syntax-highlight.ts`) registers it under the
language id `sema` and maps its scope names to `.tok-*` classes.
