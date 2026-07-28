import { defineConfig } from "tsup";

/**
 * Injected at the top of every emitted `.d.ts`.
 *
 * The public surface re-exports `@preact/signals-core`'s `Signal` type, whose
 * own declarations reference the `Disposable` global from TypeScript's
 * `esnext.disposable` lib. A consumer on a plain strict config (no
 * `skipLibCheck`, no `esnext.disposable` in `lib`) would otherwise get
 * `TS2304: Cannot find name 'Disposable'` raised inside a file they do not own.
 * A `lib` reference resolves against TypeScript's own bundled libs, so this
 * costs the consumer nothing and needs no config change from them.
 *
 * This package's own `tsconfig.json` sets `skipLibCheck: true`, so an in-repo
 * `tsc --noEmit` cannot see the problem — only a consumer build can.
 */
const DTS_BANNER = '/// <reference lib="esnext.disposable" />';

// Two configs, so neither may clean: tsup runs an array of configs
// concurrently, and a `clean` in one of them can delete the other's output
// mid-build. The `build` script empties `dist/` first instead.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    // ESM only, deliberately. The runtime targets browsers and bundlers, and
    // its own dependency `@sema-lang/sema` is ESM-only — so a CJS build could
    // never `require()` the interpreter it exists to wrap. Emitting one only
    // shipped ~186 KB (`index.cjs` + `index.d.cts`) that no resolver could
    // ever select, because `exports["."]` has no `require` condition to reach
    // it with. See the manifest checks in tests/testing-entry.test.ts.
    format: ["esm"],
    dts: { banner: DTS_BANNER },
    sourcemap: true,
    clean: false,
    external: ["@sema-lang/sema"],
  },
  {
    // `@sema-lang/sema-web/testing` — a second entry point, not part of the
    // runtime. Separate because it reads the WASM binary with `node:fs`, which
    // has no business in a browser bundle; keeping it out of `src/index.ts`
    // means the main entry cannot pull it in even by accident.
    //
    // `./index.js` stays external, so this file *imports* the runtime instead
    // of embedding a second copy of it — two copies would mean two
    // `@preact/signals-core` instances, and a signal written through one would
    // not wake an effect registered in the other.
    entry: ["src/testing.ts"],
    format: ["esm"],
    dts: { banner: DTS_BANNER },
    sourcemap: true,
    clean: false,
    external: ["@sema-lang/sema", "./index.js", "node:fs", "node:module", "node:path"],
    // Node builtins only; a browser target would try to polyfill them.
    platform: "node",
  },
]);
