import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
    setupFiles: ["tests/setup.ts"],
    // Fails the run when packages/sema-wasm/pkg was built from different Rust
    // sources than the tree holds: the real-WASM suites load that binary, and
    // nothing else in the JS path can tell you it is stale.
    globalSetup: ["scripts/wasm-freshness-unit-setup.ts"],
  },
});
