<script setup>
import CustomPageLayout from './CustomPageLayout.vue'
</script>

<template>
  <CustomPageLayout active-nav="extraction" v-slot="{ copyText }">

    <!-- ============ HERO ============ -->
    <header class="hero">
      <span class="hero-paren l" aria-hidden="true">(</span>
      <span class="hero-paren r" aria-hidden="true">)</span>
      <div class="wrap">
        <p class="eyebrow">Feature<span class="sep">·</span>LLM<span class="sep">·</span>Structured Extraction</p>
        <h1>Unstructured in, <em>typed data out.</em></h1>
        <p class="lede">
          Pass a schema, get back a typed Sema map. The schema is both the
          instruction to the model and the validator for the response — one
          artifact, two jobs. <strong>When the output doesn't match, the LLM
          fixes its own mistake.</strong>
        </p>
        <div class="hero-actions">
          <a class="btn btn-gold" href="/docs/llm/extraction">Read the docs</a>
          <a class="btn btn-ghost" href="https://sema.run">Try the playground</a>
        </div>
        <div class="hero-actions">
          <span class="install">
            <span class="cmd-text">
              <span class="dollar">$</span>
              <span id="i1">sema -e '(llm/extract {:name :string :age :number} "Alice is 30")'</span>
            </span>
            <button class="copy" @click="copyText('i1', $event)">copy</button>
          </span>
        </div>
        <p class="req">Schema-as-contract · self-correcting re-ask · per-field validators · vision extraction</p>
      </div>
    </header>

    <!-- ============ TRANSFORM SHOWCASE ============ -->
    <section class="transform-showcase">
      <div class="wrap">
        <p class="kicker">The pipeline</p>
        <h2>Text in. Typed map out. Self-correcting.</h2>
        <p class="sub">
          One call does what normally takes a prompt, a JSON parser, a
          validation layer, and a retry loop.
        </p>

        <div class="transform-flow">
          <div class="tf-stage tf-input">
            <div class="tf-badge">input</div>
            <div class="tf-card tf-text-card">
              <div class="tf-card-label">unstructured text</div>
              <div class="tf-text">"I bought coffee for $4.50 at Blue Bottle on Jan 15, 2025"</div>
            </div>
          </div>

          <div class="tf-arrow">
            <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
              <path d="M2 10h26m0 0l-7-6m7 6l-7 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>

          <div class="tf-stage tf-schema">
            <div class="tf-badge">schema</div>
            <div class="tf-card tf-schema-card">
              <div class="tf-card-label">one artifact, two jobs</div>
              <div class="tf-schema-row"><span class="tf-key">:vendor</span> <span class="tf-type">:string</span></div>
              <div class="tf-schema-row"><span class="tf-key">:amount</span> <span class="tf-type">:number</span></div>
              <div class="tf-schema-row"><span class="tf-key">:date</span> <span class="tf-type">:string</span></div>
            </div>
          </div>

          <div class="tf-arrow">
            <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
              <path d="M2 10h26m0 0l-7-6m7 6l-7 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>

          <div class="tf-stage tf-llm">
            <div class="tf-badge">llm</div>
            <div class="tf-card tf-llm-card">
              <div class="tf-card-label">JSON mode + validate</div>
              <div class="tf-llm-step">1. send schema as instructions</div>
              <div class="tf-llm-step">2. parse JSON → Sema map</div>
              <div class="tf-llm-step tf-llm-reask">3. validate → re-ask if wrong</div>
            </div>
          </div>

          <div class="tf-arrow">
            <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
              <path d="M2 10h26m0 0l-7-6m7 6l-7 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>

          <div class="tf-stage tf-output">
            <div class="tf-badge">output</div>
            <div class="tf-card tf-output-card">
              <div class="tf-card-label">typed Sema map</div>
              <div class="tf-out-row"><span class="tf-out-key">:vendor</span> <span class="tf-out-val">"Blue Bottle"</span></div>
              <div class="tf-out-row"><span class="tf-out-key">:amount</span> <span class="tf-out-val">4.5</span></div>
              <div class="tf-out-row"><span class="tf-out-key">:date</span> <span class="tf-out-val">"2025-01-15"</span></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: SCHEMA AS CONTRACT ============ -->
    <section id="schema">
      <div class="wrap">
        <div class="feature-row">
          <div class="feature-text">
            <p class="kicker">Schema as contract</p>
            <h2>One artifact. <em>Two jobs.</em></h2>
            <p class="sub">
              The schema map you pass to <code>llm/extract</code> is sent to the
              model as JSON instructions <strong>and</strong> used to validate
              the response. No separate prompt to maintain, no separate
              validator to keep in sync.
            </p>
            <ul class="feature-list">
              <li><strong>Bare shorthand.</strong> <code>{:name :string :age :number}</code> — fast to write, type sent to the model as a hint.</li>
              <li><strong>Descriptor maps.</strong> <code>{:amount {:type :number :validate #(> % 0)}}</code> — full type checking, optional fields, custom predicates.</li>
              <li><strong>Validated types.</strong> <code>:string</code>, <code>:number</code>, <code>:boolean</code>/<code>:bool</code>, <code>:list</code>/<code>:array</code> — type-checked against the response. <code>:optional</code> skips required-field checks.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">receipt.sema</span>
                <span class="n">basic extraction</span>
              </div>
              <pre>(<span class="c-kw">llm/extract</span>
  {<span class="c-kwd">:vendor</span> <span class="c-kwd">:string</span>
   <span class="c-kwd">:amount</span> <span class="c-kwd">:number</span>
   <span class="c-kwd">:date</span>   <span class="c-kwd">:string</span>}
  <span class="c-str">"I bought coffee for $4.50</span>
<span class="c-str">   at Blue Bottle on Jan 15, 2025"</span>)

<span class="c-com">;; => {:amount 4.5</span>
<span class="c-com">;;     :date "2025-01-15"</span>
<span class="c-com">;;     :vendor "Blue Bottle"}</span></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: SELF-CORRECTING RE-ASK ============ -->
    <section id="reask">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Self-correcting</p>
            <h2>When the output is wrong, <em>it tells the LLM.</em></h2>
            <p class="sub">
              If validation fails, the errors are sent back to the model so it
              can fix its own mistake — up to <code>:retries</code> times
              (default 2). Disable validation entirely with
              <code>:validate #f</code> when you trust the model.
            </p>
            <ul class="feature-list">
              <li><strong>Validate-and-reask loop.</strong> The LLM sees what went wrong and regenerates. No manual re-prompting.</li>
              <li><strong>Per-field messages.</strong> <code>:message</code> text is fed into the re-ask prompt — human-readable guidance for the model.</li>
              <li><strong>Asynchronous by default.</strong> In an async context, the initial attempt offloads to the scheduler so sibling tasks overlap.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">validate.sema</span>
                <span class="n">custom predicate + message</span>
              </div>
              <pre>(<span class="c-kw">llm/extract</span>
  {<span class="c-kwd">:age</span> {<span class="c-kwd">:type</span> <span class="c-kwd">:number</span>
          <span class="c-kwd">:validate</span> #(and (>= % 0)
                              (<= % 150))
          <span class="c-kwd">:message</span> <span class="c-str">"age must be</span>
<span class="c-str">                      between 0 and 150"</span>}}
  <span class="c-str">"She is 30 years old."</span>)

<span class="c-com">;; => {:age 30}</span>
<span class="c-com">;; (model returns 30, passes validation)</span></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: FIELD VALIDATORS (compact grid, not feature-row) ============ -->
    <section id="validators">
      <div class="wrap">
        <p class="kicker">Per-field validators</p>
        <h2>Predicates are just <em>Sema functions.</em></h2>
        <p class="sub" style="margin-bottom: 40px">
          <code>:validate</code> accepts any function — including short lambdas
          like <code>#(> % 0)</code>. The <code>:message</code> becomes part of
          the re-ask prompt when validation fails.
        </p>

        <div class="validator-grid">
          <div class="validator-card">
            <div class="validator-head">positive amount</div>
            <pre>  <span class="c-kwd">:amount</span> {<span class="c-kwd">:type</span> <span class="c-kwd">:number</span>
            <span class="c-kwd">:validate</span> #(> % 0)}</pre>
          </div>
          <div class="validator-card">
            <div class="validator-head">non-empty string</div>
            <pre>  <span class="c-kwd">:vendor</span> {<span class="c-kwd">:type</span> <span class="c-kwd">:string</span>
            <span class="c-kwd">:validate</span>
              #(> (string/length %) 0)}</pre>
          </div>
          <div class="validator-card">
            <div class="validator-head">range check + message</div>
            <pre>  <span class="c-kwd">:age</span> {<span class="c-kwd">:type</span> <span class="c-kwd">:number</span>
        <span class="c-kwd">:validate</span>
          #(and (>= % 0) (<= % 150))
        <span class="c-kwd">:message</span> <span class="c-str">"0–150"</span>}</pre>
          </div>
          <div class="validator-card">
            <div class="validator-head">optional field</div>
            <pre>  <span class="c-kwd">:nickname</span> {<span class="c-kwd">:type</span> <span class="c-kwd">:string</span>
              <span class="c-kwd">:optional</span> #t}</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: CLASSIFICATION ============ -->
    <section id="classify">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Classification</p>
            <h2>Sort text into <em>typed categories.</em></h2>
            <p class="sub">
              <code>llm/classify</code> sends the categories and the text, gets
              back one label. Pass keywords → get a keyword. Pass strings → get
              a string. Use a cheap fast model for the classification step.
            </p>
            <ul class="feature-list">
              <li><strong>Typed output.</strong> <code>(list :positive :negative :neutral)</code> in → <code>:positive</code> out. No string matching.</li>
              <li><strong>Cheap model option.</strong> <code>{:model "claude-haiku-4-5"}</code> — classification doesn't need a frontier model.</li>
              <li><strong>Async-aware.</strong> Offloads to the scheduler in async context, just like <code>llm/extract</code>.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">classify.sema</span>
                <span class="n">sentiment + spam</span>
              </div>
              <pre>(<span class="c-kw">llm/classify</span>
  (list <span class="c-kwd">:positive</span> <span class="c-kwd">:negative</span> <span class="c-kwd">:neutral</span>)
  <span class="c-str">"This product is amazing!"</span>)
<span class="c-com">;; => :positive</span>

(<span class="c-kw">llm/classify</span>
  (list <span class="c-kwd">:spam</span> <span class="c-kwd">:ham</span>)
  <span class="c-str">"WINNER!!! Claim your prize"</span>
  {<span class="c-kwd">:model</span> <span class="c-str">"claude-haiku-4-5-20251001"</span>})
<span class="c-com">;; => :spam</span></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: VISION EXTRACTION ============ -->
    <section id="vision">
      <div class="wrap">
        <div class="feature-row">
          <div class="feature-text">
            <p class="kicker">Vision extraction</p>
            <h2>Receipts, invoices, <em>screenshots.</em></h2>
            <p class="sub">
              <code>llm/extract-from-image</code> applies the same schema
              semantics to images. Pass a file path or a bytevector. Media type
              is auto-detected — PNG, JPEG, GIF, WebP, PDF. Works across
              Anthropic, OpenAI, Gemini, and Ollama.
            </p>
            <ul class="feature-list">
              <li><strong>File path or bytevector.</strong> <code>"receipt.png"</code> or <code>(file/read-bytes "invoice.jpg")</code> — both work.</li>
              <li><strong>Auto-detected media type.</strong> Magic bytes, no manual MIME configuration. Supports PNG, JPEG, GIF, WebP, PDF.</li>
              <li><strong>Multi-modal chat.</strong> <code>message/with-image</code> for freeform image conversations with <code>llm/chat</code>.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">vision.sema</span>
                <span class="n">image → typed data</span>
              </div>
              <pre>(<span class="c-kw">llm/extract-from-image</span>
  {<span class="c-kwd">:total</span> <span class="c-kwd">:number</span>
   <span class="c-kwd">:date</span>  <span class="c-kwd">:string</span>}
  <span class="c-str">"receipt.png"</span>)

<span class="c-com">;; => {:total 42.50 :date "2026-06-23"}</span>

(<span class="c-kw">define</span> img (file/read-bytes <span class="c-str">"invoice.jpg"</span>))
(<span class="c-kw">llm/extract-from-image</span>
  {<span class="c-kwd">:invoice_number</span> <span class="c-kwd">:string</span>
   <span class="c-kwd">:date</span>  <span class="c-kwd">:string</span>
   <span class="c-kwd">:total</span> <span class="c-kwd">:string</span>}
  img)
<span class="c-com">;; => {:date "2025-03-15"</span>
<span class="c-com">;;     :invoice_number "12345"</span>
<span class="c-com">;;     :total "$139.96"}</span></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ COMPARISON ============ -->
    <section id="compare">
      <div class="wrap">
        <p class="kicker">The argument</p>
        <h2>What you'd write without it.</h2>
        <p class="sub">
          The same extraction in a typical Python setup: prompt engineering,
          JSON parsing, error handling, manual validation, re-prompting logic.
          Sema does all of that in one call.
        </p>
        <div class="compare">
          <div class="pane python">
            <div class="pane-head">
              <span class="t">extract.py</span>
              <span class="n">Pydantic + LangChain</span>
            </div>
            <pre><span class="c-kw">from</span> pydantic <span class="c-kw">import</span> BaseModel
<span class="c-kw">from</span> langchain.<span class="c-fn">openai</span> <span class="c-kw">import</span> ChatOpenAI
<span class="c-kw">from</span> langchain.<span class="c-fn">core.</span>messages <span class="c-kw">import</span> HumanMessage

<span class="c-kw">class</span> <span class="c-fn">Receipt</span>(BaseModel):
    vendor: <span class="c-fn">str</span>
    amount: <span class="c-fn">float</span>
    date: <span class="c-fn">str</span>

<span class="c-kw">def</span> <span class="c-fn">extract_receipt</span>(text):
    <span class="c-kw">for</span> attempt <span class="c-kw">in</span> <span class="c-fn">range</span>(3):
        resp = llm.<span class="c-fn">invoke</span>([
            HumanMessage(content=(
                <span class="c-str">f"Extract vendor, amount, date."</span>
                <span class="c-str">f"Text: {text}"</span>
                <span class="c-str">"Return JSON only."</span>))])
        <span class="c-kw">try</span>:
            <span class="c-kw">return</span> Receipt.<span class="c-fn">model_validate_json</span>(
                resp.content)
        <span class="c-kw">except</span> Exception <span class="c-kw">as</span> e:
            text += <span class="c-str">f"Error: {e}. Fix."</span>
    <span class="c-kw">raise</span> <span class="c-fn">ValueError</span>(<span class="c-str">"failed"</span>)</pre>
            <div class="pane-foot">20 lines. Manual prompt. Manual JSON parsing. Manual retry. Manual error feedback. The schema and the prompt can drift.</div>
          </div>
          <div class="pane sema">
            <div class="pane-head">
              <span class="t">extract.sema</span>
              <span class="n">one call</span>
            </div>
            <pre>(<span class="c-kw">llm/extract</span>
  {<span class="c-kwd">:vendor</span> <span class="c-kwd">:string</span>
   <span class="c-kwd">:amount</span> <span class="c-kwd">:number</span>
   <span class="c-kwd">:date</span>   <span class="c-kwd">:string</span>}
  <span class="c-str">"I bought coffee for $4.50</span>
<span class="c-str">   at Blue Bottle on Jan 15, 2025"</span>)

<span class="c-com">;; => {:amount 4.5</span>
<span class="c-com">;;     :date "2025-01-15"</span>
<span class="c-com">;;     :vendor "Blue Bottle"}</span></pre>
            <div class="pane-foot">4 lines. Schema is the prompt and the validator. Re-ask is automatic. Typed map out of the box.</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ CTA ============ -->
    <section class="cta">
      <div class="wrap">
        <h2>Extract your first field.</h2>
        <p class="sub">One call. No prompt engineering. No JSON parsing.</p>
        <div class="install-stack">
          <div class="install-row">
            <span class="badge">run</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i2">sema -e '(llm/extract {:name :string :age :number} "John is 42")'</span>
              </span>
              <button class="copy" @click="copyText('i2', $event)">copy</button>
            </span>
          </div>
          <div class="install-row">
            <span class="badge">install</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i3">cargo install sema-lang</span>
              </span>
              <button class="copy" @click="copyText('i3', $event)">copy</button>
            </span>
          </div>
          <div class="hero-actions" style="justify-content:center; margin-top:24px">
            <a class="btn btn-gold" href="/docs/llm/extraction">Extraction docs</a>
            <a class="btn btn-ghost" href="https://sema.run">Open the playground</a>
          </div>
        </div>
      </div>
    </section>

  </CustomPageLayout>
</template>

<style scoped>
/* ---------- hero ---------- */
.hero { padding: 104px 0 56px; }

/* ---------- transform showcase ---------- */
.transform-showcase { padding: 0 0 88px; border-top: none; }

.transform-flow {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin-top: 44px;
  flex-wrap: wrap;
  justify-content: center;
}

.tf-stage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.tf-badge {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--gold);
  text-align: center;
}

.tf-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  min-height: 140px;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tf-card-label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--dim);
}

.tf-text-card .tf-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  font-style: italic;
}

.tf-schema-card { border-color: var(--gold-line); }
.tf-schema-row {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-lo);
}
.tf-schema-row:last-child { border-bottom: none; }
.tf-key { color: #b8a3d6; }
.tf-type { color: var(--gold-bright); }

.tf-llm-card {
  background: var(--gold-fade);
  border-color: var(--gold-line);
}
.tf-llm-step {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text);
}
.tf-llm-reask { color: var(--gold-bright); }

.tf-output-card { border-color: rgba(155, 184, 122, 0.2); }
.tf-out-row {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-lo);
}
.tf-out-row:last-child { border-bottom: none; }
.tf-out-key { color: #b8a3d6; }
.tf-out-val { color: #a8b88a; }

.tf-arrow {
  display: flex;
  align-items: center;
  padding: 0 8px;
  color: var(--dim);
  align-self: center;
  margin-top: 24px;
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
  font-size: 12.5px;
  line-height: 1.62;
  padding: 18px 20px;
  overflow-x: auto;
  color: #c9c2b4;
}

/* ---------- validator grid (unique to this page) ---------- */
.validator-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.validator-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.validator-head {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-lo);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--gold-bright);
  background: var(--surface);
}
.validator-card pre {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  padding: 14px 16px;
  color: #c9c2b4;
  overflow-x: auto;
}

/* ---------- comparison ---------- */
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 22px;
  margin-top: 46px;
  align-items: start;
}
.pane {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.pane.sema {
  border-color: var(--gold-line);
  box-shadow: 0 0 0 1px rgba(200, 168, 85, .08), 0 24px 60px -30px rgba(200, 168, 85, .12);
}
.pane-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--border-lo);
  font-family: var(--font-mono);
  font-size: 12px;
}
.pane-head .t { color: var(--text); }
.pane.sema .pane-head .t { color: var(--gold-bright); }
.pane-head .n { color: var(--dim); }
.pane pre {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.58;
  padding: 18px 20px;
  overflow-x: auto;
  color: #c9c2b4;
}
.pane-foot {
  padding: 13px 18px;
  border-top: 1px solid var(--border-lo);
  font-size: 13px;
  color: var(--muted);
  line-height: 1.55;
}
.pane.sema .pane-foot { color: var(--text); }

/* ---------- responsive ---------- */
@media (max-width: 880px) {
  .hero { padding: 72px 0 48px; }
  .feature-row, .feature-row.reverse { grid-template-columns: 1fr; }
  .feature-row.reverse .feature-text { order: unset; }
  .feature-row.reverse .feature-visual { order: unset; }
  .compare { grid-template-columns: 1fr; }
  .validator-grid { grid-template-columns: 1fr; }
  .transform-flow { flex-direction: column; align-items: center; }
  .tf-arrow { transform: rotate(90deg); padding: 12px 0; }
  .tf-card { min-width: 280px; }
}
</style>
