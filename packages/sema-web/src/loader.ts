/**
 * Script loader for `<script type="text/sema">` tags.
 *
 * Discovers and evaluates Sema scripts embedded in HTML pages,
 * supporting both inline code and external `.sema` files via `src`.
 *
 * @module
 */

interface SemaInterpreterLike {
  evalStr(code: string): { value: string | null; output: string[]; error: string | null };
  evalStrAsync?(code: string): Promise<{ value: string | null; output: string[]; error: string | null }>;
  loadArchive?(bytes: ArrayBuffer | Uint8Array): {
    ok: boolean;
    entryPoint: string | null;
    fileCount: number;
    semaVersion: string | null;
    buildTarget: string | null;
    buildTimestamp: string | null;
    error: string | null;
  };
  runEntry?(path: string): { value: string | null; output: string[]; error: string | null };
  runEntryAsync?(path: string): Promise<{ value: string | null; output: string[]; error: string | null }>;
}

/** Options for the script loader. */
export interface LoaderOptions {
  /**
   * MIME type to match. Default: `"text/sema"`.
   * Scripts with `type` matching this value will be evaluated.
   */
  type?: string;
}

/**
 * The slice of `SemaWebContext` the loader needs.
 *
 * Kept structural rather than importing the class so `loadScripts` stays
 * usable standalone (it is a public export, and several tests drive it with a
 * bare mock interpreter and no context at all).
 */
export interface LoaderReporter {
  diagnostics: {
    record(build: () => {
      kind: "script";
      at: number;
      context: string;
      detail?: string;
    }): void;
  };
}

/**
 * Identify a script for error messages and diagnostics.
 *
 * External scripts get their `src`; inline scripts get their position among
 * the *inline* scripts on the page. Position matters: "Error in inline script"
 * is useless on a page with six of them, which is the common case for the
 * `<script type="text/sema">` style this loader exists to support.
 */
function scriptLabel(src: string | null, inlineIndex: number): string {
  return src ? `script:${src}` : `inline-script:${inlineIndex}`;
}

/**
 * Discover and evaluate all `<script type="text/sema">` tags in the document.
 *
 * Scripts are evaluated in document order:
 * 1. External scripts (`<script type="text/sema" src="app.sema">`) are fetched first
 * 2. Inline scripts (`<script type="text/sema">...</script>`) are evaluated directly
 *
 * If the interpreter supports `evalStrAsync`, it is used for evaluation.
 * Otherwise falls back to synchronous `evalStr`.
 *
 * Errors are logged to the console but do not halt execution of subsequent scripts.
 *
 * @param interp - The Sema interpreter to evaluate scripts with
 * @param opts - Loader options
 * @returns Array of results from each script evaluation
 */
export async function loadScripts(
  interp: SemaInterpreterLike,
  opts?: LoaderOptions,
  reporter?: LoaderReporter,
): Promise<Array<{ value: string | null; output: string[]; error: string | null }>> {
  const mimeType = opts?.type ?? "text/sema";
  const scripts = document.querySelectorAll(`script[type="${mimeType}"]`);
  const results: Array<{ value: string | null; output: string[]; error: string | null }> = [];

  let inlineIndex = 0;
  const note = (context: string, detail: string) => {
    reporter?.diagnostics.record(() => ({
      kind: "script",
      at: Date.now(),
      context,
      detail,
    }));
  };

  for (const script of scripts) {
    const src = script.getAttribute("src");
    const label = scriptLabel(src, src ? -1 : inlineIndex++);
    let code: string;

    if (src) {
      try {
        const resp = await fetch(src);
        if (!resp.ok) {
          const err = `Failed to fetch ${src}: ${resp.status} ${resp.statusText}`;
          console.error(`[sema-web] ${err}`);
          note(label, err);
          results.push({ value: null, output: [], error: err });
          continue;
        }
        const artifactKind = classifyExternalScript(src);
        if (artifactKind === "archive") {
          if (!interp.loadArchive || (!interp.runEntry && !interp.runEntryAsync)) {
            const err = `Runtime does not support compiled web archives: ${src}`;
            console.error(`[sema-web] ${err}`);
            note(label, err);
            results.push({ value: null, output: [], error: err });
            continue;
          }

          const bytes = new Uint8Array(await resp.arrayBuffer());
          let archiveInfo;
          try {
            archiveInfo = interp.loadArchive(bytes);
          } catch (e) {
            const err = `Failed to load archive ${src}: ${e instanceof Error ? e.message : String(e)}`;
            console.error(`[sema-web] ${err}`);
            note(label, err);
            results.push({ value: null, output: [], error: err });
            continue;
          }

          if (!archiveInfo.ok) {
            const err = archiveInfo.error || `Failed to load archive ${src}`;
            console.error(`[sema-web] ${err}`);
            note(label, err);
            results.push({ value: null, output: [], error: err });
            continue;
          }

          if (!archiveInfo.entryPoint) {
            const err = `Archive ${src} did not provide an entry point`;
            console.error(`[sema-web] ${err}`);
            note(label, err);
            results.push({ value: null, output: [], error: err });
            continue;
          }

          const result = interp.runEntryAsync
            ? await interp.runEntryAsync(archiveInfo.entryPoint)
            : interp.runEntry!(archiveInfo.entryPoint);

          for (const line of result.output) {
            console.log(`[sema] ${line}`);
          }

          if (result.error) {
            console.error(`[sema-web] Error in ${label}: ${result.error}`);
            note(label, result.error);
          } else {
            note(label, `loaded archive ${archiveInfo.entryPoint}`);
          }

          results.push(result);
          continue;
        }

        code = await resp.text();
      } catch (e) {
        const err = `Failed to fetch ${src}: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[sema-web] ${err}`);
        note(label, err);
        results.push({ value: null, output: [], error: err });
        continue;
      }
    } else {
      code = script.textContent ?? "";
    }

    if (!code.trim()) {
      results.push({ value: null, output: [], error: null });
      continue;
    }

    try {
      const result = interp.evalStrAsync
        ? await interp.evalStrAsync(code)
        : interp.evalStr(code);

      // Log output lines to console
      for (const line of result.output) {
        console.log(`[sema] ${line}`);
      }

      if (result.error) {
        console.error(`[sema-web] Error in ${label}: ${result.error}`);
        note(label, result.error);
      } else {
        note(label, "evaluated");
      }

      results.push(result);
    } catch (e) {
      const err = `Evaluation error in ${label}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[sema-web] ${err}`);
      note(label, err);
      results.push({ value: null, output: [], error: err });
    }
  }

  return results;
}

function classifyExternalScript(src: string): "source" | "archive" {
  const url = new URL(src, document.baseURI);
  if (url.pathname.endsWith(".vfs")) {
    return "archive";
  }
  return "source";
}
