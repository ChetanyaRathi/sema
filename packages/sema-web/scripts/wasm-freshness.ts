/**
 * Does the browser WASM binary match the Rust sources in this tree?
 *
 * Every e2e fixture and every `renderSema` screen boots the real VM out of
 * `packages/sema-wasm/pkg/sema_wasm_bg.wasm`. That file is gitignored and
 * nothing in the JS test path built it: `npm test` is a bare `vitest run` and
 * `npm run test:e2e` a bare `playwright test`, so editing a crate and running
 * either exercised whatever VM happened to be built last — and reported green.
 * A suite that structurally cannot see the artifact under test is the same
 * failure class as the shipped-assets bug AGENTS.md opens with.
 *
 * The check is a fingerprint, not a build: running `wasm-pack` from a test
 * harness would make a JS run take minutes and would need a Rust toolchain that
 * a JS-only contributor does not have. Instead the binary carries a stamp of the
 * sources it was built from, and a mismatch fails loudly with the one command
 * that fixes it.
 *
 * **Self-bootstrapping, deliberately.** The stamp is *adopted* whenever the
 * binary itself has changed (a different mtime or size than the stamp records),
 * because that means some build produced it — `npm run build:wasm`, `jake
 * wasm.build`, a raw `wasm-pack`, or CI's content-keyed cache restore. So no
 * build entry point has to remember to stamp, and CI (whose cache key already
 * hashes exactly these sources) is correct without a workflow step. The one
 * blind spot is the very first run against an unstamped binary, which is
 * adopted as-is; every Rust edit after that is caught.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What the check reads. Explicit so it can be pointed at a fixture tree. */
export interface FreshnessInputs {
  /** Files and directories the binary is compiled from. */
  sources: string[];
  /** The built binary. */
  wasmPath: string;
  /** Where the adopted fingerprint is kept. */
  stampPath: string;
}

/**
 * Outcome of a freshness check.
 *
 * `"adopted"` is distinct from `"fresh"`: nothing was verified, the binary was
 * simply recorded as the one these sources produced.
 */
export type FreshnessStatus = "fresh" | "stale" | "missing" | "adopted";

/** Result of a freshness check, with a message worth printing. */
export interface FreshnessReport {
  status: FreshnessStatus;
  /** Human-readable explanation; always set for `stale` and `missing`. */
  message: string;
}

interface Stamp {
  /** Fingerprint of the rule that produced `sourceHash` — see {@link ruleHash}. */
  rule: string;
  sourceHash: string;
  wasmMtimeMs: number;
  wasmSize: number;
}

/** Directories never worth hashing: build output and generated corpora. */
const SKIPPED_DIRS = new Set(["target", "pkg", "node_modules", "corpus", "artifacts"]);

/**
 * Does this file's content reach the compiled binary?
 *
 * Narrower than the workflow's `hashFiles(crates/…/**)`, and deliberately: a
 * gate that demands a two-minute WASM rebuild after a typo in a crate README is
 * one that gets deleted. Anything under a `src/` directory counts whatever its
 * extension, because `include_str!` makes an asset there part of the binary.
 */
function affectsBinary(path: string): boolean {
  if (/\.(rs|toml|lock)$/.test(path)) return true;
  return path.split(/[\\/]/).includes("src");
}

/** Repo root, resolved from this file rather than from the process cwd. */
export function repoRoot(): string {
  // scripts/ -> packages/sema-web -> packages -> repo root
  return resolve(fileURLToPath(import.meta.url), "../../../..");
}

/**
 * The sources the browser binary is built from.
 *
 * The crate list mirrors the `hashFiles(...)` cache key in
 * `.github/workflows/sema-web-tests.yml`: when the workflow's list changes this
 * one has to change with it, or a local run and CI would disagree about what
 * "current" means. Which *files* within them count is narrower — see
 * {@link affectsBinary}.
 */
export function defaultInputs(root = repoRoot()): FreshnessInputs {
  const pkgDir = join(root, "packages", "sema-wasm", "pkg");
  return {
    sources: [
      join(root, "Cargo.toml"),
      join(root, "Cargo.lock"),
      ...[
        "sema-core",
        "sema-eval",
        "sema-fmt",
        "sema-otel",
        "sema-reader",
        "sema-stdlib",
        "sema-vm",
        "sema-wasm",
      ].map((crate) => join(root, "crates", crate)),
    ],
    wasmPath: join(pkgDir, "sema_wasm_bg.wasm"),
    // Inside the artifact directory on purpose: `pkg/.gitignore` is `*`, and
    // deleting the directory has to take the stamp with it.
    stampPath: join(pkgDir, ".sema-web-source-stamp.json"),
  };
}

function collectFiles(path: string, out: string[]): void {
  let entry;
  try {
    entry = statSync(path);
  } catch {
    return; // A source that is not there is part of the fingerprint by absence.
  }
  if (entry.isFile()) {
    if (affectsBinary(path)) out.push(path);
    return;
  }
  if (!entry.isDirectory()) return;
  for (const child of readdirSync(path, { withFileTypes: true })) {
    if (child.name.startsWith(".")) continue;
    if (child.isDirectory() && SKIPPED_DIRS.has(child.name)) continue;
    collectFiles(join(path, child.name), out);
  }
}

/**
 * Content fingerprint of the Rust sources.
 *
 * Paths are part of the digest, so adding or renaming a file changes it even
 * when no byte of any surviving file did.
 */
export function hashSources(inputs: FreshnessInputs, root = repoRoot()): string {
  const files: string[] = [];
  for (const source of inputs.sources) collectFiles(source, files);
  files.sort();

  const digest = createHash("sha256");
  for (const file of files) {
    // NUL delimits path from contents so no filename can spell out a
    // neighbouring file's bytes. Escaped, not literal, to keep this a
    // text file; the digest is byte-identical either way.
    digest.update(relative(root, file));
    digest.update("\u0000");
    digest.update(readFileSync(file));
    digest.update("\u0000");
  }
  return digest.digest("hex");
}

/**
 * Fingerprint of *how* the sources are hashed, not of the sources.
 *
 * A stamp is only comparable with a digest computed the same way, so editing
 * the crate list or {@link affectsBinary} has to re-adopt rather than report
 * every binary in the world stale. Derived from the rule itself so that no
 * future edit depends on remembering to bump a constant.
 */
function ruleHash(inputs: FreshnessInputs, root: string): string {
  return createHash("sha256")
    .update(inputs.sources.map((source) => relative(root, source)).join("|"))
    .update(Array.from(SKIPPED_DIRS).sort().join("|"))
    .update(affectsBinary.toString())
    .digest("hex");
}

function readStamp(stampPath: string): Stamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf8")) as Partial<Stamp>;
    if (
      typeof parsed.rule !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      typeof parsed.wasmMtimeMs !== "number" ||
      typeof parsed.wasmSize !== "number"
    ) {
      return null;
    }
    return parsed as Stamp;
  } catch {
    return null;
  }
}

function writeStamp(stampPath: string, stamp: Stamp): void {
  try {
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch {
    // A read-only or missing artifact directory degrades the check to "always
    // adopt", which is exactly the behaviour that existed before it. Failing a
    // test run over an unwritable bookkeeping file would be worse than the gap.
  }
}

/** Compare the built binary with the sources, adopting it if it just changed. */
export function inspectWasmFreshness(
  inputs: FreshnessInputs = defaultInputs(),
  root = repoRoot(),
): FreshnessReport {
  if (!existsSync(inputs.wasmPath)) {
    return {
      status: "missing",
      message:
        `${relative(root, inputs.wasmPath)} does not exist, and every browser fixture boots `
        + "the real VM from it.\nBuild it from the repo root:  npm run build:wasm",
    };
  }

  const built = statSync(inputs.wasmPath);
  const stamp = readStamp(inputs.stampPath);
  const sourceHash = hashSources(inputs, root);
  const rule = ruleHash(inputs, root);

  if (
    !stamp
    || stamp.rule !== rule
    || stamp.wasmMtimeMs !== built.mtimeMs
    || stamp.wasmSize !== built.size
  ) {
    writeStamp(inputs.stampPath, {
      rule,
      sourceHash,
      wasmMtimeMs: built.mtimeMs,
      wasmSize: built.size,
    });
    return {
      status: "adopted",
      message: `recorded ${relative(root, inputs.wasmPath)} as built from the current sources`,
    };
  }

  if (stamp.sourceHash !== sourceHash) {
    return {
      status: "stale",
      message:
        `${relative(root, inputs.wasmPath)} was built from different Rust sources than the ones `
        + "in this tree.\nThe JS suites load that binary directly, so a green run would be a "
        + "statement about an unknown-vintage VM.\nRebuild it from the repo root:  "
        + "npm run build:wasm",
    };
  }

  return { status: "fresh", message: "wasm matches the Rust sources in this tree" };
}

/**
 * Fail the run when the binary cannot be trusted.
 *
 * `requireBuilt` separates the two harnesses: the browser fixtures cannot run
 * at all without the binary, while the vitest suites that need it gate
 * themselves on {@link semaWasmAvailable} and skip, so a JS-only contributor is
 * not told the runtime is broken when the real message is "run the wasm build".
 */
export function assertWasmFresh(
  options: { requireBuilt: boolean } = { requireBuilt: false },
  inputs: FreshnessInputs = defaultInputs(),
  root = repoRoot(),
): FreshnessReport {
  const report = inspectWasmFreshness(inputs, root);
  if (report.status === "stale" || (report.status === "missing" && options.requireBuilt)) {
    throw new Error(`[sema-web] ${report.message}`);
  }
  return report;
}

