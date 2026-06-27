<script setup>
import CustomPageLayout from './CustomPageLayout.vue'
</script>

<template>
  <CustomPageLayout active-nav="observability" v-slot="{ copyText }">

    <!-- ============ HERO ============ -->
    <header class="hero">
      <span class="hero-paren l" aria-hidden="true">(</span>
      <span class="hero-paren r" aria-hidden="true">)</span>
      <div class="wrap">
        <p class="eyebrow">Feature<span class="sep">·</span>Observability<span class="sep">·</span>OpenTelemetry</p>
        <h1>Every call, <em>traced.</em></h1>
        <p class="lede">
          Set one environment variable and every <code>llm/complete</code>,
          <code>agent/run</code>, tool dispatch, and retry is recorded as an
          OpenTelemetry trace — automatically, no instrumentation code.
          <strong>GenAI semantic conventions</strong> so backends understand it
          out of the box. Off by default; never blocks your run.
        </p>
        <div class="hero-actions">
          <a class="btn btn-gold" href="/docs/llm/observability">Read the docs</a>
          <a class="btn btn-ghost" href="https://sema.run">Try the playground</a>
        </div>
        <div class="hero-actions">
          <span class="install">
            <span class="cmd-text">
              <span class="dollar">$</span>
              <span id="i1">OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 sema agent.sema</span>
            </span>
            <button class="copy" @click="copyText('i1', $event)">copy</button>
          </span>
        </div>
        <p class="req">Jaeger · Grafana · Langfuse · Datadog · Honeycomb · SigNoz · and more</p>
      </div>
    </header>

    <!-- ============ SPAN TREE VISUALIZATION ============ -->
    <section class="trace-showcase">
      <div class="wrap">
        <p class="kicker">What a trace looks like</p>
        <h2>An agent run, as a span tree.</h2>
        <p class="sub">
          One <code>agent/run</code> produces a tree of nested spans. The agent
          span contains LLM call spans and tool execution spans. Retries nest
          under the LLM call that triggered them. Every span carries GenAI
          attributes — model, token counts, cost, finish reason.
        </p>

        <div class="trace-card">
          <div class="trace-header">
            <span class="trace-service">sema</span>
            <span class="trace-duration">847ms</span>
            <span class="trace-spans">6 spans</span>
          </div>

          <div class="trace-tree">
            <div class="span-row span-root">
              <div class="span-bar" style="width: 100%">
                <span class="span-name">invoke_agent <span class="span-attr">coder</span></span>
                <span class="span-time">847ms</span>
              </div>
            </div>

            <div class="span-row span-child">
              <div class="span-bar span-bar-llm" style="width: 62%; margin-left: 0%">
                <span class="span-name">chat <span class="span-attr">claude-sonnet-4</span></span>
                <span class="span-time">524ms</span>
              </div>
            </div>

            <div class="span-row span-child">
              <div class="span-bar span-bar-tool" style="width: 18%; margin-left: 0%">
                <span class="span-name">execute_tool <span class="span-attr">read-file</span></span>
                <span class="span-time">152ms</span>
              </div>
            </div>

            <div class="span-row span-child">
              <div class="span-bar span-bar-llm" style="width: 55%; margin-left: 0%">
                <span class="span-name">chat <span class="span-attr">claude-sonnet-4</span></span>
                <span class="span-time">465ms</span>
              </div>
            </div>

            <div class="span-row span-child span-nested">
              <div class="span-bar span-bar-retry" style="width: 22%; margin-left: 0%">
                <span class="span-name">llm.retry_attempt</span>
                <span class="span-time">103ms</span>
              </div>
            </div>

            <div class="span-row span-child">
              <div class="span-bar span-bar-tool" style="width: 12%; margin-left: 0%">
                <span class="span-name">execute_tool <span class="span-attr">run-command</span></span>
                <span class="span-time">98ms</span>
              </div>
            </div>
          </div>

          <div class="trace-attrs">
            <div class="attr-group">
              <div class="attr-label">gen_ai.request.model</div>
              <div class="attr-value">claude-sonnet-4</div>
            </div>
            <div class="attr-group">
              <div class="attr-label">gen_ai.usage.input_tokens</div>
              <div class="attr-value">1,247</div>
            </div>
            <div class="attr-group">
              <div class="attr-label">gen_ai.usage.output_tokens</div>
              <div class="attr-value">382</div>
            </div>
            <div class="attr-group">
              <div class="attr-label">gen_ai.usage.cost</div>
              <div class="attr-value">$0.012</div>
            </div>
            <div class="attr-group">
              <div class="attr-label">gen_ai.response.finish_reasons</div>
              <div class="attr-value">["stop"]</div>
            </div>
            <div class="attr-group">
              <div class="attr-label">sema.gen_ai.cache.hit</div>
              <div class="attr-value">false</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: ONE ENV VAR ============ -->
    <section id="setup">
      <div class="wrap">
        <div class="feature-row">
          <div class="feature-text">
            <p class="kicker">Setup</p>
            <h2>One variable. That's it.</h2>
            <p class="sub">
              Point Sema at your tracing backend with a single environment
              variable. Every LLM call, tool dispatch, agent run, and retry is
              instrumented automatically — no code changes, no SDK imports, no
              wrapper functions. Tracing is off by default; set neither variable
              and nothing is recorded.
            </p>
            <ul class="feature-list">
              <li><strong>Network backend.</strong> <code>OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318</code> — sends spans to Jaeger, Grafana, Langfuse, any OTLP receiver.</li>
              <li><strong>File backend.</strong> <code>SEMA_OTEL_FILE=/tmp/trace.jsonl</code> — writes spans to a local file, one JSON object per line. No backend needed.</li>
              <li><strong>Never blocks.</strong> Telemetry is sent in the background. A slow or dead backend can't delay or crash your script.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="term">
              <div class="head">terminal — one-minute setup</div>
              <div><span class="c-com"># Start Jaeger (free, local)</span></div>
              <div><span class="dollar">$</span> docker run --rm -d -p 4318:4318 \</div>
              <div>&nbsp;&nbsp;-p 16686:16686 jaegertracing/all-in-one</div>
              <div>&nbsp;</div>
              <div><span class="c-com"># Point Sema at it and run</span></div>
              <div><span class="dollar">$</span> OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \</div>
              <div>&nbsp;&nbsp;sema -e '(llm/complete "hi" {:max-tokens 16})'</div>
              <div class="out">→ "Hello! How can I help?"</div>
              <div>&nbsp;</div>
              <div><span class="c-com"># Open http://localhost:16686 — trace is there</span></div>
              <div class="ok">✓ 1 trace · 1 span · 42 tok · $0.0003</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: WHAT GETS TRACED ============ -->
    <section id="what-traced">
      <div class="wrap">
        <p class="kicker">Automatic instrumentation</p>
        <h2>What gets traced — without you writing anything.</h2>

        <div class="spans-grid">
          <div class="span-card">
            <div class="span-kind span-kind-client">CLIENT</div>
            <div class="span-op">chat {model}</div>
            <div class="span-when">Every <code>llm/complete</code> and <code>llm/chat</code> — including cache hits</div>
          </div>
          <div class="span-card">
            <div class="span-kind span-kind-client">CLIENT</div>
            <div class="span-op">embeddings {model}</div>
            <div class="span-when">Every <code>llm/embed</code> call</div>
          </div>
          <div class="span-card">
            <div class="span-kind span-kind-internal">INTERNAL</div>
            <div class="span-op">execute_tool {name}</div>
            <div class="span-when">Every tool dispatch in an agent loop</div>
          </div>
          <div class="span-card">
            <div class="span-kind span-kind-internal">INTERNAL</div>
            <div class="span-op">invoke_agent {name}</div>
            <div class="span-when">Every <code>agent/run</code> and tools-enabled completion</div>
          </div>
          <div class="span-card">
            <div class="span-kind span-kind-internal">INTERNAL</div>
            <div class="span-op">notebook.run_all</div>
            <div class="span-when">A notebook "Run All" — one child span per cell</div>
          </div>
          <div class="span-card">
            <div class="span-kind span-kind-internal">INTERNAL</div>
            <div class="span-op">llm.retry_attempt</div>
            <div class="span-when">Each HTTP retry (429 / 5xx / network), nested under the LLM span</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: BACKENDS ============ -->
    <section id="backends">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Backend compatibility</p>
            <h2>Works with your tools.</h2>
            <p class="sub">
              Sema follows the OpenTelemetry GenAI semantic conventions, so any
              OTLP-compatible backend reads the traces natively. A handful of
              LLM-specific tools need a compat flag — one env var, no code
              changes.
            </p>
            <ul class="feature-list">
              <li><strong>No compat mode needed.</strong> Jaeger, Grafana/Tempo, SigNoz, OpenObserve, Honeycomb, Datadog, Dynatrace, Logfire.</li>
              <li><strong>One env var for the rest.</strong> <code>SEMA_OTEL_COMPAT=langfuse</code> (or <code>openinference</code>, <code>arize</code>, etc.) adds extra attribute names alongside the standard <code>gen_ai.*</code> ones.</li>
              <li><strong>Auth via headers.</strong> <code>OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ..."</code> — standard OTLP auth, works with any hosted backend.</li>
            </ul>
            <p class="sub" style="margin-top:18px">
              <a href="/docs/llm/otel-compat">Backend compatibility guide &rarr;</a>
            </p>
          </div>
          <div class="feature-visual">
            <div class="backends-grid">
              <div class="backend-chip">Jaeger</div>
              <div class="backend-chip">Grafana</div>
              <div class="backend-chip">Langfuse</div>
              <div class="backend-chip">Datadog</div>
              <div class="backend-chip">Honeycomb</div>
              <div class="backend-chip">SigNoz</div>
              <div class="backend-chip">OpenObserve</div>
              <div class="backend-chip">Logfire</div>
              <div class="backend-chip">Phoenix</div>
              <div class="backend-chip">Elastic</div>
              <div class="backend-chip">Dynatrace</div>
              <div class="backend-chip">New Relic</div>
              <div class="backend-chip">Coralogix</div>
              <div class="backend-chip">MLflow</div>
              <div class="backend-chip">LangSmith</div>
              <div class="backend-chip backend-chip-more">+ more</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: CUSTOM SPANS ============ -->
    <section id="custom-spans">
      <div class="wrap">
        <div class="feature-row">
          <div class="feature-text">
            <p class="kicker">Custom spans</p>
            <h2>Add your own. Or don't.</h2>
            <p class="sub">
              The built-in <code>llm/*</code> and <code>agent/*</code> calls are
              traced for you. When you build your own abstractions — a RAG loop,
              a batch job, a custom provider — typed span helpers let them emit
              first-class spans too. Every one is a <strong>no-op when tracing
              is off</strong>, so they're safe to leave in.
            </p>
            <ul class="feature-list">
              <li><strong>Generic spans.</strong> <code>(with-span "ingest-batch" {:batch.size 100} ...)</code> — name, attributes, body.</li>
              <li><strong>Typed spans.</strong> <code>otel/llm-span</code>, <code>otel/tool-span</code>, <code>otel/retrieval-span</code> — render like the built-ins in backends.</li>
              <li><strong>Annotate the current span.</strong> <code>otel/set-attribute</code>, <code>otel/event</code>, <code>otel/set-status</code> — typed values, not strings.</li>
              <li><strong>Session grouping.</strong> <code>(with-session "chat-42" {:user "alice"} ...)</code> — groups spans for Langfuse sessions.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">pipeline.sema</span>
                <span class="n">custom spans</span>
              </div>
              <pre>(<span class="c-kw">with-span</span> <span class="c-str">"ingest-batch"</span>
  {<span class="c-kwd">:batch.size</span> 100}
  (<span class="c-kw">otel/event</span> <span class="c-str">"started"</span> {})
  (<span class="c-kw">otel/retrieval-span</span>
    <span class="c-str">"vector-search"</span>
    (<span class="c-kw">lambda</span> ()
      (search index query))
    {<span class="c-kwd">:top-k</span> 5}))

(<span class="c-kw">otel/llm-span</span>
  {<span class="c-kwd">:model</span> <span class="c-str">"custom-model"</span>
   <span class="c-kwd">:provider</span> <span class="c-str">"myco"</span>}
  (<span class="c-kw">lambda</span> ()
    (<span class="c-kw">define</span> resp (my-llm-call prompt))
    (<span class="c-kw">otel/llm-usage</span>
      {<span class="c-kwd">:input-tokens</span> 120
       <span class="c-kwd">:output-tokens</span> 30
       <span class="c-kwd">:cost-usd</span> 0.001})
    resp))</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: METRICS & PRIVACY ============ -->
    <section id="metrics-privacy">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Metrics &amp; privacy</p>
            <h2>Counts without content.</h2>
            <p class="sub">
              When exporting over a network endpoint, Sema also records two GenAI
              metric histograms: token usage and operation duration. Prompt and
              response <strong>text</strong> is never recorded unless you
              explicitly opt in — token counts, model names, cost, and timing
              carry no message text and are always exported.
            </p>
            <ul class="feature-list">
              <li><strong>Token usage metric.</strong> <code>gen_ai.client.token.usage</code> — input/output token counts per call.</li>
              <li><strong>Duration metric.</strong> <code>gen_ai.client.operation.duration</code> — call latency in seconds.</li>
              <li><strong>Content capture is opt-in.</strong> Set <code>OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true</code> to record prompt/response text. Off by default; long messages are truncated.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="metrics-card">
              <div class="metrics-head">gen_ai.client.token.usage</div>
              <div class="metrics-bars">
                <div class="metric-bar"><span class="metric-label">input</span><div class="metric-fill" style="width: 78%"></div><span class="metric-val">1,247</span></div>
                <div class="metric-bar"><span class="metric-label">output</span><div class="metric-fill metric-fill-out" style="width: 24%"></div><span class="metric-val">382</span></div>
              </div>
              <div class="metrics-sep"></div>
              <div class="metrics-head">gen_ai.client.operation.duration</div>
              <div class="metrics-bars">
                <div class="metric-bar"><span class="metric-label">p50</span><div class="metric-fill" style="width: 35%"></div><span class="metric-val">340ms</span></div>
                <div class="metric-bar"><span class="metric-label">p95</span><div class="metric-fill metric-fill-out" style="width: 72%"></div><span class="metric-val">720ms</span></div>
                <div class="metric-bar"><span class="metric-label">p99</span><div class="metric-fill metric-fill-out" style="width: 88%"></div><span class="metric-val">890ms</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ CTA ============ -->
    <section class="cta">
      <div class="wrap">
        <h2>Turn it on. See everything.</h2>
        <p class="sub">One environment variable between you and a full trace tree.</p>
        <div class="install-stack">
          <div class="install-row">
            <span class="badge">otel</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i2">OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 sema agent.sema</span>
              </span>
              <button class="copy" @click="copyText('i2', $event)">copy</button>
            </span>
          </div>
          <div class="install-row">
            <span class="badge">file</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i3">SEMA_OTEL_FILE=/tmp/trace.jsonl sema agent.sema</span>
              </span>
              <button class="copy" @click="copyText('i3', $event)">copy</button>
            </span>
          </div>
          <div class="hero-actions" style="justify-content:center; margin-top:24px">
            <a class="btn btn-gold" href="/docs/llm/observability">Observability docs</a>
            <a class="btn btn-ghost" href="/docs/llm/otel-compat">Backend compatibility</a>
          </div>
        </div>
      </div>
    </section>

  </CustomPageLayout>
</template>

<style scoped>
/* ---------- hero ---------- */
.hero { padding: 104px 0 56px; }

/* ---------- trace showcase ---------- */
.trace-showcase { padding: 0 0 88px; border-top: none; }

.trace-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  margin-top: 40px;
  box-shadow: 0 0 0 1px rgba(200, 168, 85, .04), 0 24px 60px -30px rgba(0, 0, 0, .3);
}

.trace-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--border-lo);
  font-family: var(--font-mono);
  font-size: 12px;
}

.trace-service { color: var(--gold-bright); font-weight: 500; }
.trace-duration { color: var(--text); }
.trace-spans { color: var(--dim); margin-left: auto; }

.trace-tree {
  padding: 18px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.span-row {
  display: flex;
  align-items: center;
}

.span-root { padding-bottom: 6px; }

.span-child {
  padding-left: 28px;
}

.span-nested {
  padding-left: 56px;
}

.span-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--bg);
  border: 1px solid var(--border-lo);
  min-width: 0;
}

.span-bar-llm {
  border-color: var(--gold-line);
  background: var(--gold-fade);
}

.span-bar-tool {
  border-color: rgba(155, 184, 122, 0.2);
  background: rgba(155, 184, 122, 0.05);
}

.span-bar-retry {
  border-color: rgba(201, 123, 106, 0.2);
  background: rgba(201, 123, 106, 0.04);
  border-style: dashed;
}

.span-name {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.span-bar-llm .span-name { color: var(--gold-bright); }
.span-bar-tool .span-name { color: #9bb87a; }
.span-bar-retry .span-name { color: #c97b6a; }

.span-attr {
  color: var(--dim);
  font-size: 10px;
}

.span-time {
  color: var(--dim);
  font-size: 10.5px;
  flex-shrink: 0;
}

/* trace attributes */
.trace-attrs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border-lo);
  border-top: 1px solid var(--border-lo);
}

.attr-group {
  background: var(--bg);
  padding: 10px 14px;
}

.attr-label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--dim);
  margin-bottom: 3px;
}

.attr-value {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--gold-bright);
}

/* ---------- feature rows ---------- */
.feature-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 56px;
  align-items: center;
  margin-top: 20px;
}

.feature-row.reverse .feature-text { order: 2; }
.feature-row.reverse .feature-visual { order: 1; }

.feature-list { margin-top: 24px; }

.feature-list li {
  padding: 10px 0;
  font-size: 14.5px;
  color: var(--muted);
  line-height: 1.65;
  border-bottom: 1px solid var(--border-lo);
}

.feature-list li:last-child { border-bottom: none; }

.feature-list strong { color: var(--text); font-weight: 500; display: block; margin-bottom: 2px; }

.feature-list code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--gold-bright);
  background: var(--gold-fade);
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
}

/* ---------- code card ---------- */
.code-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(200, 168, 85, .04), 0 20px 50px -30px rgba(0, 0, 0, .3);
}

.code-card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--border-lo);
  font-family: var(--font-mono);
  font-size: 12px;
}

.code-card-head .t { color: var(--gold-bright); }
.code-card-head .n { color: var(--dim); }

.code-card pre {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.62;
  padding: 18px 20px;
  overflow-x: auto;
  color: #c9c2b4;
}

/* ---------- spans grid ---------- */
.spans-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-top: 40px;
}

.span-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
}

.span-kind {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: inline-block;
  margin-bottom: 10px;
}

.span-kind-client {
  color: var(--gold-bright);
  background: var(--gold-fade);
  border: 1px solid var(--gold-line);
}

.span-kind-internal {
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
}

.span-op {
  font-family: var(--font-mono);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 6px;
}

.span-when {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}

.span-when code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--gold-bright);
  background: var(--gold-fade);
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
}

/* ---------- backends grid ---------- */
.backends-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.backend-chip {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 16px;
  transition: all .12s;
}

.backend-chip:hover {
  border-color: var(--gold-line);
  color: var(--gold-bright);
}

.backend-chip-more {
  color: var(--dim);
  border-style: dashed;
}

/* ---------- metrics card ---------- */
.metrics-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  box-shadow: 0 0 0 1px rgba(200, 168, 85, .04), 0 20px 50px -30px rgba(0, 0, 0, .3);
}

.metrics-head {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--gold-bright);
  margin-bottom: 12px;
}

.metrics-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.metric-label {
  color: var(--dim);
  width: 32px;
  flex-shrink: 0;
}

.metric-fill {
  height: 8px;
  background: var(--gold);
  border-radius: 4px;
  min-width: 4px;
}

.metric-fill-out {
  background: rgba(200, 168, 85, 0.4);
}

.metric-val {
  color: var(--text);
  flex-shrink: 0;
}

.metrics-sep {
  height: 1px;
  background: var(--border-lo);
  margin: 16px 0;
}

/* ---------- responsive ---------- */
@media (max-width: 880px) {
  .hero { padding: 72px 0 48px; }

  .feature-row, .feature-row.reverse {
    grid-template-columns: 1fr;
  }
  .feature-row.reverse .feature-text { order: unset; }
  .feature-row.reverse .feature-visual { order: unset; }

  .spans-grid { grid-template-columns: 1fr; }

  .trace-attrs { grid-template-columns: 1fr 1fr; }

  .span-child { padding-left: 16px; }
  .span-nested { padding-left: 32px; }
}
</style>
