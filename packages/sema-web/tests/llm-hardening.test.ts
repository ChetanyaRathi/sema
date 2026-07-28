/**
 * Hardening coverage for the browser LLM proxy client.
 *
 * `llm.test.ts` covers the happy stream path. This file covers the contract
 * around it: header precedence (an auth bug is silent and total), the stream
 * protocol's error and terminal-state handling, cancellation, and ownership.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerLlmBindings,
  buildProxyHeaders,
  buildProxyHeadersMap,
  createStreamAccumulator,
  type LlmStreamState,
} from "../src/llm.js";
import { SemaWebContext, disposeContextResources } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";

function makeSseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("buildProxyHeaders", () => {
  it("always sends JSON content type", () => {
    expect(buildProxyHeaders({ url: "u" })).toEqual({ "Content-Type": "application/json" });
  });

  it("adds a bearer token", () => {
    expect(buildProxyHeaders({ url: "u", token: "t" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer t",
    });
  });

  it("merges custom headers", () => {
    expect(buildProxyHeaders({ url: "u", headers: { "X-App": "demo" } })).toEqual({
      "Content-Type": "application/json",
      "X-App": "demo",
    });
  });

  it("lets a custom header override the content type", () => {
    // Not a security boundary — a proxy may want an explicit charset.
    const headers = buildProxyHeaders({
      url: "u",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("passes a custom Authorization header through when no token is configured", () => {
    // Proxies using a non-Bearer scheme must keep working.
    const headers = buildProxyHeaders({ url: "u", headers: { Authorization: "Basic abc" } });
    expect(headers.Authorization).toBe("Basic abc");
  });

  describe("token vs. custom Authorization", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("the token wins", () => {
      const headers = buildProxyHeaders({
        url: "u",
        token: "real",
        headers: { Authorization: "Basic stale" },
      });
      expect(headers.Authorization).toBe("Bearer real");
    });

    it("wins over a differently-cased header too", () => {
      // Header names are case-insensitive on the wire; a lowercase key that
      // survived alongside the token would send two Authorization headers.
      const headers = buildProxyHeaders({
        url: "u",
        token: "real",
        headers: { authorization: "Basic stale" },
      });
      expect(Object.keys(headers).filter((k) => /^authorization$/i.test(k))).toEqual([
        "Authorization",
      ]);
      expect(headers.Authorization).toBe("Bearer real");
    });

    it("warns, rather than resolving the contradiction silently", () => {
      buildProxyHeaders({ url: "u", token: "real", headers: { Authorization: "Basic stale" } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("token"));
    });

    it("does not warn when there is no conflict", () => {
      buildProxyHeaders({ url: "u", token: "real", headers: { "X-App": "demo" } });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("produces one header set for both transports", () => {
    // The regression this pins: headers were built twice with opposite
    // precedence, so the same config authenticated differently depending on
    // whether the call streamed.
    const opts = { url: "u", token: "t", headers: { "X-App": "demo" } };
    const map = buildProxyHeadersMap(opts);
    for (const [k, v] of Object.entries(buildProxyHeaders(opts))) {
      expect(map).toContain(`"${k}" "${v}"`);
    }
  });

  it("emits each header name exactly once in the Sema map literal", () => {
    const map = buildProxyHeadersMap({
      url: "u",
      token: "t",
      headers: { Authorization: "Basic stale" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(map.match(/"Authorization"/g)).toHaveLength(1);
  });

  it("escapes quotes and backslashes for Sema source embedding", () => {
    const map = buildProxyHeadersMap({ url: "u", headers: { "X-A": 'has"quote\\slash' } });
    expect(map).toContain('has\\"quote\\\\slash');
  });
});

describe("createStreamAccumulator", () => {
  let states: LlmStreamState[];
  let acc: ReturnType<typeof createStreamAccumulator>;

  beforeEach(() => {
    states = [];
    acc = createStreamAccumulator((s) => states.push(s));
  });

  const last = () => states[states.length - 1];

  it("accumulates tokens in order", () => {
    acc.event('{"type":"token","text":"Hello"}');
    acc.event('{"type":"token","text":" world"}');

    expect(last()).toEqual({ text: "Hello world", done: false, error: null });
  });

  it("marks done on the done frame", () => {
    acc.event('{"type":"token","text":"hi"}');
    acc.event('{"type":"done"}');

    expect(last()).toEqual({ text: "hi", done: true, error: null });
  });

  it("accepts the OpenAI-style [DONE] sentinel", () => {
    // A proxy passing a provider stream straight through emits this. Treating
    // it as corrupt JSON turned a clean finish into a spurious error.
    acc.event('{"type":"token","text":"hi"}');
    acc.event("[DONE]");

    expect(last()).toEqual({ text: "hi", done: true, error: null });
  });

  it("reports an error frame with its message", () => {
    acc.event('{"type":"error","error":"rate limited"}');
    expect(last()).toEqual({ text: "", done: true, error: "rate limited" });
  });

  it("falls back to a generic message for an error frame with no message", () => {
    acc.event('{"type":"error"}');
    expect(last().error).toBe("Stream error");
  });

  it("reports malformed JSON as a payload error", () => {
    acc.event("not json at all");
    expect(last()).toEqual({ text: "", done: true, error: "Invalid stream payload" });
  });

  it("ignores unknown frame types instead of treating them as corruption", () => {
    // Proxies add metadata frames (usage, model echo). An app should not break
    // because its proxy got more informative.
    acc.event('{"type":"token","text":"hi"}');
    acc.event('{"type":"usage","tokens":12}');

    expect(last()).toEqual({ text: "hi", done: false, error: null });
  });

  it("ignores a token frame whose text is not a string", () => {
    acc.event('{"type":"token","text":42}');
    expect(states).toEqual([]);
  });

  it("ignores empty data", () => {
    acc.event("");
    expect(states).toEqual([]);
  });

  describe("terminal states latch", () => {
    it("a token after an error frame cannot clear the error", () => {
      // The bug this pins: the old handler rebuilt the whole value on every
      // token, so a trailing frame reset `error` to null and `done` to false —
      // the UI cleared the error it had just shown and hung forever.
      acc.event('{"type":"error","error":"boom"}');
      acc.event('{"type":"token","text":"late"}');

      expect(last()).toEqual({ text: "", done: true, error: "boom" });
    });

    it("a token after done cannot reopen the stream", () => {
      acc.event('{"type":"token","text":"hi"}');
      acc.event('{"type":"done"}');
      acc.event('{"type":"token","text":" more"}');

      expect(last()).toEqual({ text: "hi", done: true, error: null });
    });

    it("a transport failure after done is ignored", () => {
      acc.event('{"type":"done"}');
      acc.fail("connection reset");

      expect(last().error).toBeNull();
    });

    it("close after an error preserves the error", () => {
      acc.event('{"type":"error","error":"boom"}');
      acc.close();

      expect(last()).toEqual({ text: "", done: true, error: "boom" });
    });
  });

  it("a transport failure reports the message and finishes the stream", () => {
    acc.event('{"type":"token","text":"part"}');
    acc.fail("HTTP 502");

    expect(last()).toEqual({ text: "part", done: true, error: "HTTP 502" });
  });

  it("close without a done frame finishes without inventing an error", () => {
    // A proxy that just closes after its last token is terse, not broken.
    acc.event('{"type":"token","text":"all done"}');
    acc.close();

    expect(last()).toEqual({ text: "all done", done: true, error: null });
  });

  it("close on an untouched stream still settles it", () => {
    acc.close();
    expect(last()).toEqual({ text: "", done: true, error: null });
  });

  it("exposes the current state without emitting", () => {
    acc.event('{"type":"token","text":"hi"}');
    const before = states.length;

    expect(acc.state).toEqual({ text: "hi", done: false, error: null });
    expect(states).toHaveLength(before);
  });
});

describe("llm stream integration", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    registerLlmBindings(
      interp,
      { url: "https://proxy.example.com/llm/", token: "abc", headers: { "X-App": "demo" } },
      ctx,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function startStream(opts: Record<string, unknown> = {}): number {
    return interp.getFunction("__llm/chat-stream-raw")!(
      JSON.stringify([{ ":role": "user", ":content": "hi" }]),
      JSON.stringify(opts),
    );
  }

  it("strips the trailing slash from the proxy URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    startStream();
    await flushAsyncWork();

    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example.com/llm/stream");
  });

  it("sends the same headers the request path uses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    startStream();
    await flushAsyncWork();

    expect(fetchMock.mock.calls[0][1].headers).toEqual(
      buildProxyHeaders({
        url: "https://proxy.example.com/llm",
        token: "abc",
        headers: { "X-App": "demo" },
      }),
    );
  });

  it("strips Sema keyword colons from the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    startStream({ ":model": "gpt-4o" });
    await flushAsyncWork();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-4o",
      stream: true,
    });
  });

  it("always sets stream: true, even if the caller says otherwise", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    startStream({ stream: false });
    await flushAsyncWork();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
  });

  it("surfaces an HTTP failure through the signal, not an exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );

    const id = startStream();
    await flushAsyncWork();

    const value = ctx.signals.get(id)!.value as LlmStreamState;
    expect(value.done).toBe(true);
    expect(value.error).toContain("500");
  });

  it("surfaces a network rejection through the signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const id = startStream();
    await flushAsyncWork();

    expect(ctx.signals.get(id)!.value).toEqual({
      text: "",
      done: true,
      error: "offline",
    });
  });

  it("keeps partial text when the stream dies mid-flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"token","text":"par"}\n\n'),
              );
            },
            // Erroring in `pull` (after the queued chunk is delivered) rather
            // than in `start` — `controller.error()` discards anything still
            // queued, which would test chunk loss instead of mid-flight death.
            pull(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const id = startStream();
    await flushAsyncWork();

    const value = ctx.signals.get(id)!.value as LlmStreamState;
    expect(value.text).toBe("par");
    expect(value.done).toBe(true);
    expect(value.error).toBeTruthy();
  });

  it("deregisters the stream once it finishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSseResponse(['data: {"type":"done"}\n\n'])),
    );

    const id = startStream();
    await flushAsyncWork();

    expect(ctx.streams.has(id)).toBe(false);
  });

  describe("close", () => {
    it("settles the signal with the full shape even if no frame arrived", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      );

      const id = startStream();
      interp.getFunction("__llm/close-stream")!(id);

      // A bare `{done: true}` would make (:text (deref s)) return nil in Sema,
      // where every other path yields "".
      expect(ctx.signals.get(id)!.value).toEqual({ text: "", done: true, error: null });
    });

    it("releases component ownership so unmount does not double-close", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse([])));
      const component = {
        instanceId: 7,
        componentFn: "view",
        ownedStreamIds: new Set<number>(),
      };
      ctx.mountedComponents.set("#app", component as any);
      ctx.mountedComponentsById.set(7, component as any);
      ctx.ownerStack.push(7);
      const id = startStream();
      ctx.ownerStack.pop();
      expect(component.ownedStreamIds.has(id)).toBe(true);

      interp.getFunction("__llm/close-stream")!(id);

      expect(component.ownedStreamIds.has(id)).toBe(false);
    });

    it("is a no-op for an unknown signal id", () => {
      expect(() => interp.getFunction("__llm/close-stream")!(9999)).not.toThrow();
    });

    it("is idempotent", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      );
      const id = startStream();

      interp.getFunction("__llm/close-stream")!(id);
      expect(() => interp.getFunction("__llm/close-stream")!(id)).not.toThrow();
      expect((ctx.signals.get(id)!.value as LlmStreamState).done).toBe(true);
    });
  });

  it("disposing the context aborts an in-flight stream", async () => {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return Promise.resolve(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      }),
    );

    startStream();
    disposeContextResources(ctx);
    await flushAsyncWork();

    expect(aborted).toBe(true);
  });

  it("records stream lifecycle in the dev timeline", async () => {
    ctx.diagnostics.enabled = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSseResponse(['data: {"type":"done"}\n\n'])),
    );

    startStream();
    await flushAsyncWork();

    expect(ctx.diagnostics.byKind("stream").map((e) => e.detail)).toEqual(["open", "close"]);
  });
});

describe("registerLlmBindings wiring", () => {
  it("throws with the interpreter's message if the Sema half fails to load", () => {
    const interp = {
      registerFunction: vi.fn(),
      evalStr: () => ({ value: null, output: [], error: "unbound variable: nope" }),
    };

    expect(() =>
      registerLlmBindings(interp as any, { url: "u" }, new SemaWebContext()),
    ).toThrow(/unbound variable: nope/);
  });

  it("registers llm/proxy-url with the normalized URL", () => {
    const interp = createMockInterpreter();
    registerLlmBindings(interp, { url: "https://p.example/llm///" }, new SemaWebContext());

    expect(interp.getFunction("llm/proxy-url")!()).toBe("https://p.example/llm");
  });
});
