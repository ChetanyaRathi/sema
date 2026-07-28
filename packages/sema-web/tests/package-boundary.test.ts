/**
 * What an installed consumer sees.
 *
 * Every other suite in this package imports `../src/*`, so nothing in it ever
 * resolves the package by name, through its own `exports` map, into `dist/`.
 * That blind spot is not hypothetical: `exports["."]` shipped with no condition
 * a `require()` could match, so `require("@sema-lang/sema-web")` failed with
 * ERR_PACKAGE_PATH_NOT_EXPORTED while 186 KB of CJS output was built and
 * published for a resolver that could never select it. A green `tsc --noEmit`
 * from inside the package cannot see any of that — the checkout has everything
 * the installed copy lacks.
 *
 * These tests therefore work from outside: a throwaway project whose
 * `node_modules` holds a symlink to this package, resolved by Node and by
 * `tsc` exactly as a real dependent would.
 *
 * The manifest checks run always; anything that reads `dist/` is skipped when
 * the package has not been built, so a test run before `npm run build` does not
 * report a packaging failure.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const PKG_DIR = process.cwd();
const DIST = resolve(PKG_DIR, "dist");
const PKG = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8"));

const describeBuilt = existsSync(resolve(DIST, "index.js")) ? describe : describe.skip;

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway project that depends on this package through a `node_modules`
 * symlink.
 *
 * Node and TypeScript both resolve a symlinked dependency's own imports from
 * its real path, so `@sema-lang/sema` still resolves out of the workspace —
 * only the *entry* resolution is the consumer's, which is the part under test.
 */
function makeConsumer(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sema-web-consumer-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@sema-lang"), { recursive: true });
  symlinkSync(PKG_DIR, join(dir, "node_modules", "@sema-lang", "sema-web"), "dir");
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

/** Run a snippet in the consumer, returning stdout (stderr is folded in). */
function runNode(dir: string, type: "module" | "commonjs", code: string): string {
  return execFileSync(process.execPath, [`--input-type=${type}`, "-e", code], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("exports map", () => {
  it("lists the types condition first in every subpath", () => {
    // Conditions are matched in declaration order, so a `types` entry after
    // `import` is shadowed for any resolver that also matches `import`.
    for (const [subpath, conditions] of Object.entries(PKG.exports)) {
      if (typeof conditions === "string") continue;
      expect(Object.keys(conditions as object)[0], `${subpath} conditions`).toBe("types");
    }
  });

  it("points every condition at a path inside the published files", () => {
    for (const [subpath, conditions] of Object.entries(PKG.exports)) {
      const targets =
        typeof conditions === "string" ? [conditions] : Object.values(conditions as object);
      for (const target of targets) {
        expect(target, `${subpath}`).toMatch(/^\.\/(dist\/|package\.json$)/);
      }
    }
  });

  it("has a condition every resolver can match, not only bundlers", () => {
    // `import` alone leaves `require()` with nothing to select, which is an
    // ERR_PACKAGE_PATH_NOT_EXPORTED rather than an honest "this is ESM".
    for (const [subpath, conditions] of Object.entries(PKG.exports)) {
      if (typeof conditions === "string") continue;
      expect(Object.keys(conditions as object), `${subpath}`).toContain("default");
    }
  });

  it("exposes package.json, which build tools read directly", () => {
    expect(PKG.exports["./package.json"]).toBe("./package.json");
  });
});

describeBuilt("built output", () => {
  it("has a real file behind every exports condition", () => {
    for (const conditions of Object.values(PKG.exports)) {
      const targets =
        typeof conditions === "string" ? [conditions] : Object.values(conditions as object);
      for (const target of targets) {
        expect(existsSync(resolve(PKG_DIR, target)), target).toBe(true);
      }
    }
    expect(existsSync(resolve(PKG_DIR, PKG.main))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, PKG.types))).toBe(true);
  });

  it("ships no CJS output, because nothing could ever load it", () => {
    // The runtime targets browsers and bundlers, and `@sema-lang/sema` is
    // itself ESM-only — a CJS build could not `require()` the interpreter it
    // wraps. Emitting one only added unreachable weight to the tarball.
    const stray = ["index.cjs", "index.d.cts", "testing.cjs", "testing.d.cts"].filter((f) =>
      existsSync(resolve(DIST, f)),
    );
    expect(stray).toEqual([]);
  });

  it("declares the lib its public types depend on", () => {
    // The public surface re-exports @preact/signals-core's `Signal`, whose
    // declarations reference the `Disposable` global. Without this reference a
    // consumer on a plain strict config gets TS2304 raised inside a file they
    // do not own; this package's own `skipLibCheck: true` hides it in-repo.
    for (const file of ["index.d.ts", "testing.d.ts"]) {
      expect(readFileSync(resolve(DIST, file), "utf8").split("\n")[0]).toBe(
        '/// <reference lib="esnext.disposable" />',
      );
    }
  });
});

describeBuilt("resolution from an installed consumer", () => {
  it("resolves the runtime for an ESM importer", () => {
    const dir = makeConsumer({ "package.json": '{"name":"c","version":"1.0.0","type":"module"}' });

    const out = runNode(
      dir,
      "module",
      'const m = await import("@sema-lang/sema-web"); console.log(typeof m.SemaWeb);',
    );

    expect(out).toBe("function");
  });

  it("resolves the runtime for a CJS requirer instead of refusing the subpath", () => {
    const dir = makeConsumer({ "package.json": '{"name":"c","version":"1.0.0"}' });

    const out = runNode(
      dir,
      "commonjs",
      'const m = require("@sema-lang/sema-web"); console.log(typeof m.SemaWeb);',
    );

    expect(out).toBe("function");
  });

  it("resolves the testing subpath", () => {
    const dir = makeConsumer({ "package.json": '{"name":"c","version":"1.0.0","type":"module"}' });

    const out = runNode(
      dir,
      "module",
      'const m = await import("@sema-lang/sema-web/testing"); console.log(typeof m.renderSema);',
    );

    expect(out).toBe("function");
  });
});

describeBuilt("type-checking from an installed consumer", () => {
  it("type-checks under a strict config that does not skip lib checks", () => {
    // `skipLibCheck` defaults to false in tsc, so this is what a consumer gets
    // out of the box — and it is the only configuration that can see a type
    // this package drags in from a dependency it does not control.
    const dir = makeConsumer({
      "package.json": '{"name":"c","version":"1.0.0","type":"module"}',
      "app.ts": [
        'import { SemaWeb } from "@sema-lang/sema-web";',
        'import type { SemaWebContext } from "@sema-lang/sema-web";',
        "export const boot = (): Promise<SemaWeb> => SemaWeb.create();",
        "export const signalCount = (ctx: SemaWebContext): number => ctx.signals.size;",
      ].join("\n"),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          strict: true,
          lib: ["es2023", "dom"],
          noEmit: true,
        },
        include: ["app.ts"],
      }),
    });
    const tsc = resolve(PKG_DIR, "node_modules/typescript/bin/tsc");
    const tscPath = existsSync(tsc)
      ? tsc
      : resolve(PKG_DIR, "../../node_modules/typescript/bin/tsc");

    let output = "";
    let failed = false;
    try {
      execFileSync(process.execPath, [tscPath, "-p", "tsconfig.json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      output = String((e as { stdout?: string }).stdout ?? e);
    }

    expect(output).toBe("");
    expect(failed).toBe(false);
  }, 60_000);
});
