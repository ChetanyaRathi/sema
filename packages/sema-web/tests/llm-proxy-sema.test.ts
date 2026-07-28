/**
 * Validate the Sema half of the LLM proxy client against a real interpreter.
 *
 * `buildLlmProxySema` emits ~110 lines of Sema embedded in a TypeScript
 * string. Nothing in the type checker, the bundler, or the rest of this suite
 * can see a typo in it: `interp.evalStr` is mocked everywhere else, so a
 * malformed `cond` or a misspelled builtin would sail through CI and only
 * surface as a thrown `SemaWeb.create()` in a browser.
 *
 * These tests run the generated source through the repository's own `sema`
 * binary. They are skipped when it is absent (a fresh checkout, or a
 * contributor working only on the JS side), because failing there would report
 * "your LLM bindings are broken" when the real message is "run cargo build".
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildProxyHeadersMap, buildLlmProxySema, type LlmProxyOptions } from "../src/llm.js";

const SEMA_BIN = resolve(process.cwd(), "../../target/release/sema");
const haveBinary = existsSync(SEMA_BIN);
const describeWithSema = haveBinary ? describe : describe.skip;

/**
 * Build the exact source `registerLlmBindings` would evaluate.
 *
 * Uses the real serializer rather than a local copy — a re-implementation here
 * would test the copy, and the escaping tests below would pass while the
 * shipped path stayed vulnerable.
 */
function generate(opts: LlmProxyOptions): string {
  return buildLlmProxySema(opts.url.replace(/\/+$/, ""), buildProxyHeadersMap(opts));
}

/** Evaluate Sema source plus an expression, returning trimmed stdout. */
function runSema(source: string, expression: string): string {
  return execFileSync(SEMA_BIN, ["--no-llm", "-e", `${source}\n${expression}`], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

describeWithSema("generated LLM proxy Sema", () => {
  const source = generate({ url: "https://proxy.example.com/llm", token: "secret" });

  it("loads without error", () => {
    // The baseline this file exists for: the source parses and every form
    // evaluates. Catches an unbalanced paren, a bad `cond`, a typo'd builtin.
    expect(runSema(source, '(println "loaded")')).toContain("loaded");
  });

  it("defines the whole documented public API", () => {
    const api = [
      "llm/complete",
      "llm/chat",
      "llm/send",
      "llm/extract",
      "llm/classify",
      "llm/embed",
      "llm/list-models",
      "llm/chat-stream",
      "llm/close-stream",
    ];
    const checks = api.map((name) => `(println "${name}=" (procedure? ${name}))`).join("\n");

    const out = runSema(source, checks);

    for (const name of api) {
      expect(out).toContain(`${name}= #t`);
    }
  });

  it("does not shadow the core `message` special form", () => {
    // Asserting the absence of a definition that cannot work. Re-adding one
    // here would be silently dead code. Matched at line start so the comment
    // explaining *why* it is absent does not trip the check.
    expect(source).not.toMatch(/^\(define \(message[ )]/m);
  });

  it("bakes the proxy URL and headers in as literals", () => {
    const out = runSema(
      source,
      '(println __llm-proxy-url)\n(println (get __llm-proxy-headers "Authorization"))',
    );

    expect(out).toContain("https://proxy.example.com/llm");
    expect(out).toContain("Bearer secret");
  });

  describe("message normalization", () => {
    it("converts a core (message ...) value into an encodable map", () => {
      // `message` is a special form in the Sema core and always wins in
      // operator position (limitations.md #36). Its :message value cannot be
      // JSON-encoded, so the documented `(llm/chat (list (message :user "Hi")))`
      // failed outright until requests started funnelling through here.
      const out = runSema(
        source,
        '(println (json/encode (__llm-normalize-messages (list (message :user "hi")))))',
      );
      expect(JSON.parse(out.trim())).toEqual([{ role: "user", content: "hi" }]);
    });

    it("leaves a plain map message alone", () => {
      const out = runSema(
        source,
        `(println (json/encode (__llm-normalize-messages (list {:role "assistant" :content "yo"}))))`,
      );
      expect(JSON.parse(out.trim())).toEqual([{ role: "assistant", content: "yo" }]);
    });

    it("handles a mixed list of core messages and plain maps", () => {
      const out = runSema(
        source,
        `(println (json/encode (__llm-normalize-messages (list (message :user "a") {:role "assistant" :content "b"}))))`,
      );
      expect(JSON.parse(out.trim())).toEqual([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]);
    });

    it("normalizes a bare, non-list message", () => {
      // llm/send accepts a single prompt object, not only a list.
      const out = runSema(
        source,
        '(println (json/encode (__llm-normalize-messages (message :system "be brief"))))',
      );
      expect(JSON.parse(out.trim())).toEqual({ role: "system", content: "be brief" });
    });

    it("every request path that encodes messages goes through it", () => {
      // Guards the actual wiring, not just the helper: llm/chat, llm/send and
      // llm/chat-stream must each normalize, or the bug returns for whichever
      // one was missed.
      const generated = source;
      for (const fn of ["llm/chat", "llm/send", "llm/chat-stream"]) {
        const body = generated.slice(generated.indexOf(`(define (${fn} `));
        const end = body.indexOf("\n(define ");
        expect(end === -1 ? body : body.slice(0, end)).toContain("__llm-normalize-messages");
      }
    });
  });

  describe("__llm-proxy-normalize — the shared error contract", () => {
    it("decodes a 200 JSON body", () => {
      const out = runSema(
        source,
        `(println (:content (__llm-proxy-normalize "chat" {:status 200 :body "{\\"content\\":\\"hello\\"}"})))`,
      );
      expect(out.trim()).toBe("hello");
    });

    it("treats a missing status as success", () => {
      // Not every http/* shim sets :status; absence must not read as failure.
      const out = runSema(
        source,
        `(println (:content (__llm-proxy-normalize "chat" {:body "{\\"content\\":\\"ok\\"}"})))`,
      );
      expect(out.trim()).toBe("ok");
    });

    it("raises on a 4xx, naming the endpoint and status", () => {
      const out = runSema(
        source,
        `(println (try (__llm-proxy-normalize "chat" {:status 401 :body "no key"}) (catch e (:message e))))`,
      );
      expect(out).toContain("llm proxy chat failed: HTTP 401");
      expect(out).toContain("no key");
    });

    it("raises on a 5xx", () => {
      const out = runSema(
        source,
        `(println (try (__llm-proxy-normalize "embed" {:status 503 :body ""}) (catch e (:message e))))`,
      );
      expect(out).toContain("llm proxy embed failed: HTTP 503");
    });

    it("raises a clear error for a non-JSON 200 body rather than leaking a decoder error", () => {
      const out = runSema(
        source,
        `(println (try (__llm-proxy-normalize "chat" {:status 200 :body "<html>gateway</html>"}) (catch e (:message e))))`,
      );
      // A misconfigured proxy returning an HTML error page is the common case;
      // "not valid JSON" points at it, a raw decoder message does not.
      expect(out).toContain("llm proxy chat returned a body that is not valid JSON");
    });

    it("maps an empty 200 body to an empty map, not an error", () => {
      const out = runSema(
        source,
        `(println (map? (__llm-proxy-normalize "chat" {:status 200 :body ""})))`,
      );
      expect(out.trim()).toBe("#t");
    });

    it("passes a non-map response straight through", () => {
      const out = runSema(source, `(println (__llm-proxy-normalize "chat" "raw"))`);
      expect(out.trim()).toBe("raw");
    });

    it("returns the response itself when the body is not a string", () => {
      const out = runSema(
        source,
        `(println (:status (__llm-proxy-normalize "chat" {:status 200 :body 42})))`,
      );
      expect(out.trim()).toBe("200");
    });
  });

  it("escapes a token containing quotes and backslashes", () => {
    // The token is interpolated into Sema source. An unescaped quote would end
    // the string literal and turn the rest of the program into garbage — a
    // parse error at best, arbitrary Sema at worst.
    const nasty = 'tok"en\\with\ttabs';
    const hostile = generate({ url: "https://p.example", token: nasty });

    const out = runSema(hostile, '(println (get __llm-proxy-headers "Authorization"))');

    expect(out).toContain(`Bearer ${nasty.replace(/\t/g, "\t")}`);
  });

  it("escapes a hostile custom header value", () => {
    const hostile = generate({
      url: "https://p.example",
      headers: { "X-Evil": '" (println "pwned") "' },
    });

    const out = runSema(hostile, '(println "still-ok")');

    expect(out).toContain("still-ok");
    expect(out).not.toContain("pwned");
  });

  it("escapes a hostile proxy URL", () => {
    const hostile = generate({ url: 'https://p.example/" (println "pwned") "' });

    const out = runSema(hostile, '(println "still-ok")');

    expect(out).toContain("still-ok");
    expect(out).not.toContain("pwned");
  });
});
