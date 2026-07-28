import { defineConfig } from "vite";

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    // `@sema-lang/sema-web` is here for dist-bundle.html, the one fixture that
    // imports the package by name instead of from `src/`. Pre-bundling it would
    // let a cached copy of a previous `dist/` answer for the current one, which
    // is precisely what that fixture exists to rule out.
    exclude: ["@sema-lang/sema", "@sema-lang/sema-web"],
  },
  assetsInclude: ["**/*.wasm"],
});
