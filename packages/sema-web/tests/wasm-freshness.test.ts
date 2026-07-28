/**
 * The gate that makes a green JS run a statement about the current Rust source.
 *
 * `packages/sema-wasm/pkg` is gitignored and no JS entry point ever built it,
 * so `npm test` and `npx playwright test` exercised whatever VM happened to be
 * built last — the same "a suite that cannot see the artifact under test"
 * failure the shipped-assets rule in AGENTS.md exists for.
 *
 * Driven against a throwaway tree rather than the real one: asserting on the
 * repo's own wasm would make the test's result depend on whether the machine
 * running it had built one, which is the very ambiguity being removed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWasmFresh,
  hashSources,
  inspectWasmFreshness,
  type FreshnessInputs,
} from "../scripts/wasm-freshness.js";

let root: string;
let inputs: FreshnessInputs;

const crateFile = (name: string, body: string) => {
  const path = join(root, "crates", "sema-vm", "src", name);
  mkdirSync(join(root, "crates", "sema-vm", "src"), { recursive: true });
  writeFileSync(path, body);
  return path;
};

/** Write the binary the way a build would: new bytes, new mtime. */
const buildWasm = (body: string) => {
  const path = join(root, "packages", "sema-wasm", "pkg", "sema_wasm_bg.wasm");
  mkdirSync(join(root, "packages", "sema-wasm", "pkg"), { recursive: true });
  writeFileSync(path, body);
  const when = new Date(Date.now() + body.length * 1000);
  utimesSync(path, when, when);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sema-wasm-fresh-"));
  writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
  crateFile("vm.rs", "fn main() {}\n");
  buildWasm("wasm-v1");
  const pkgDir = join(root, "packages", "sema-wasm", "pkg");
  inputs = {
    sources: [join(root, "Cargo.toml"), join(root, "crates", "sema-vm")],
    wasmPath: join(pkgDir, "sema_wasm_bg.wasm"),
    stampPath: join(pkgDir, ".sema-web-source-stamp.json"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("wasm freshness gate", () => {
  it("adopts an unstamped binary and records what built it", () => {
    const report = inspectWasmFreshness(inputs, root);

    expect(report.status).toBe("adopted");
    expect(existsSync(inputs.stampPath)).toBe(true);
  });

  it("reports a stamped binary against unchanged sources as fresh", () => {
    inspectWasmFreshness(inputs, root);

    expect(inspectWasmFreshness(inputs, root).status).toBe("fresh");
  });

  it("fails when a crate changed and the binary did not", () => {
    inspectWasmFreshness(inputs, root);
    crateFile("vm.rs", "fn main() { println!(\"edited\"); }\n");

    const report = inspectWasmFreshness(inputs, root);
    expect(report.status).toBe("stale");
    expect(report.message).toContain("npm run build:wasm");
    expect(() => assertWasmFresh({ requireBuilt: false }, inputs, root)).toThrow(
      /different Rust sources/,
    );
  });

  it("notices a crate file that was added, not only one that was edited", () => {
    inspectWasmFreshness(inputs, root);
    crateFile("extra.rs", "pub fn added() {}\n");

    expect(inspectWasmFreshness(inputs, root).status).toBe("stale");
  });

  it("clears once the binary is rebuilt", () => {
    inspectWasmFreshness(inputs, root);
    crateFile("vm.rs", "fn main() { println!(\"edited\"); }\n");
    expect(inspectWasmFreshness(inputs, root).status).toBe("stale");

    // Any build path re-stamps: `npm run build:wasm`, `jake wasm.build`, a raw
    // `wasm-pack`, or CI restoring its content-keyed cache.
    buildWasm("wasm-v2-longer");

    expect(inspectWasmFreshness(inputs, root).status).toBe("adopted");
    expect(inspectWasmFreshness(inputs, root).status).toBe("fresh");
  });

  it("only fails an absent binary for the harness that cannot run without it", () => {
    rmSync(inputs.wasmPath);

    const report = inspectWasmFreshness(inputs, root);
    expect(report.status).toBe("missing");
    // The vitest suites that need the VM gate themselves and skip.
    expect(() => assertWasmFresh({ requireBuilt: false }, inputs, root)).not.toThrow();
    // Every browser fixture boots it, so there the absence is the failure.
    expect(() => assertWasmFresh({ requireBuilt: true }, inputs, root)).toThrow(/build:wasm/);
  });

  it("ignores build output living inside a crate directory", () => {
    inspectWasmFreshness(inputs, root);
    const target = join(root, "crates", "sema-vm", "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "libsema.rlib"), "binary junk");

    expect(inspectWasmFreshness(inputs, root).status).toBe("fresh");
  });

  it("hashes the same tree to the same digest", () => {
    const first = hashSources(inputs, root);
    // Touching a file without changing its bytes must not read as a new build.
    const when = new Date(Date.now() + 60_000);
    utimesSync(join(root, "crates", "sema-vm", "src", "vm.rs"), when, when);

    expect(hashSources(inputs, root)).toBe(first);
  });

  it("re-adopts rather than crying stale when the hashing rule itself changed", () => {
    inspectWasmFreshness(inputs, root);
    // A stamp written under a different definition of "the sources" is not
    // comparable with one written under this definition. Editing the crate list
    // must not report every binary in the world as stale.
    const widened = { ...inputs, sources: [...inputs.sources, join(root, "Cargo.lock")] };

    expect(inspectWasmFreshness(widened, root).status).toBe("adopted");
    expect(inspectWasmFreshness(widened, root).status).toBe("fresh");
  });

  it("survives an unwritable artifact directory rather than failing the run", () => {
    const report = inspectWasmFreshness(
      { ...inputs, stampPath: join(root, "does", "not", "exist", "stamp.json") },
      root,
    );

    expect(report.status).toBe("adopted");
  });

  it("keeps the real repo's own inputs resolvable", async () => {
    // Guards the path arithmetic in `defaultInputs`, which no fixture exercises:
    // a wrong repo root would silently hash nothing and call every binary fresh.
    const { defaultInputs, repoRoot } = await import("../scripts/wasm-freshness.js");
    const real = defaultInputs();

    expect(existsSync(join(repoRoot(), "Cargo.toml"))).toBe(true);
    expect(real.sources.every((source) => existsSync(source))).toBe(true);
    expect(statSync(real.sources[real.sources.length - 1]).isDirectory()).toBe(true);
  });
});
