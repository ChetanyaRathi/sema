/**
 * The bundle boundary between the runtime and the testing utilities.
 *
 * `src/testing.ts` reads the WASM binary with `node:fs`, which must never reach
 * a browser bundle. Nothing in the unit suite can catch that on its own: every
 * other test imports from `src/`, where module boundaries are still separate
 * files and a stray import costs nothing. Only the built output shows whether
 * the two entry points actually stayed apart, so this suite reads `dist/`.
 *
 * Skipped when `dist/` is absent — a test run before `npm run build` should not
 * report a packaging failure.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIST = resolve(process.cwd(), "dist");
const PKG = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

const read = (file: string): string => readFileSync(resolve(DIST, file), "utf8");

/** Any import or require of a Node built-in, with or without the `node:` prefix. */
const NODE_BUILTIN_RE =
  /(?:from|import|require)\s*\(?\s*["'](?:node:)?(?:fs|path|module|url|child_process|os|crypto)["']/;

const describeBuilt = existsSync(resolve(DIST, "index.js")) ? describe : describe.skip;

describe("package manifest", () => {
  it("publishes the testing utilities as their own subpath", () => {
    expect(PKG.exports["./testing"]).toEqual({
      types: "./dist/testing.d.ts",
      import: "./dist/testing.js",
      default: "./dist/testing.js",
    });
  });

  it("keeps the main entry pointing at the runtime", () => {
    expect(PKG.exports["."].import).toBe("./dist/index.js");
  });

  it("ships dist, so the subpath resolves for an installed consumer", () => {
    expect(PKG.files).toContain("dist/");
  });
});

describeBuilt("built runtime entry", () => {
  it("imports no Node built-in", () => {
    // The reason the testing helpers are a separate entry at all.
    expect(read("index.js")).not.toMatch(NODE_BUILTIN_RE);
  });

  it("contains none of the testing API", () => {
    for (const file of ["index.js", "index.d.ts"]) {
      expect(read(file)).not.toContain("renderSema");
    }
  });
});

describeBuilt("built testing entry", () => {
  it("exists at the path the manifest advertises", () => {
    for (const file of ["testing.js", "testing.d.ts"]) {
      expect(existsSync(resolve(DIST, file))).toBe(true);
    }
  });

  it("exports the harness", () => {
    expect(read("testing.js")).toContain("renderSema");
  });

  it("imports the runtime instead of embedding a second copy of it", () => {
    const testing = read("testing.js");
    expect(testing).toMatch(/import\(["']\.\/index\.js["']\)/);
    // Two bundled copies would also mean two `@preact/signals-core` instances,
    // so a signal written through one would not wake the other's effects.
    // These strings are unique to runtime modules the harness never re-exports.
    expect(testing).not.toContain("Failed to register component wrappers");
    expect(testing).not.toContain("data-sema-on-");
  });

  it("reaches the runtime only through a dynamic import", () => {
    // A static import would resolve `@sema-lang/sema-wasm` while the module
    // graph is being built, so a checkout with no WASM build would fail at
    // import time — before `semaWasmAvailable()` could skip the suite.
    expect(read("testing.js")).not.toMatch(/^import[^(]*from ["']\.\/index\.js["']/m);
  });

  it("stays small, because it is a wrapper and not a bundle", () => {
    // A regression here means the externals stopped applying and the runtime
    // got inlined; the runtime entry is over 100 KB.
    expect(read("testing.js").length).toBeLessThan(40_000);
  });
});
