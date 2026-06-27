<script setup>
import CustomPageLayout from './CustomPageLayout.vue'
</script>

<template>
  <CustomPageLayout active-nav="embed" v-slot="{ copyText }">

    <!-- ============ HERO ============ -->
    <header class="hero">
      <span class="hero-paren l" aria-hidden="true">(</span>
      <span class="hero-paren r" aria-hidden="true">)</span>
      <div class="wrap">
        <p class="eyebrow">Feature<span class="sep">·</span>Runtime<span class="sep">·</span>Embedding</p>
        <h1>Put a Lisp <em>in your app.</em></h1>
        <p class="lede">
          Embed Sema in <strong>Rust</strong> as a native scripting engine, or
          in <strong>JavaScript</strong> via WASM in the browser. Same language,
          two host targets. Sandboxed when you need it, scriptable by design,
          with LLM primitives built in.
        </p>
        <div class="hero-actions">
          <a class="btn btn-gold" href="/docs/embedding">Rust docs</a>
          <a class="btn btn-ghost" href="/docs/embedding-js">JS docs</a>
        </div>
        <div class="hero-actions">
          <span class="install">
            <span class="cmd-text">
              <span class="dollar">$</span>
              <span id="i1">cargo add sema-lang  ·  npm i @sema-lang/sema</span>
            </span>
            <button class="copy" @click="copyText('i1', $event)">copy</button>
          </span>
        </div>
        <p class="req">9 sandbox capabilities · in-browser VFS · LSP + DAP built in · CDN-ready</p>
      </div>
    </header>

    <!-- ============ SPLIT TARGET VISUAL ============ -->
    <section class="split-showcase">
      <div class="wrap">
        <p class="kicker">Two targets, one language</p>
        <h2>Same <code>(sema)</code>, different host.</h2>

        <div class="split-diagram">
          <div class="split-branch left">
            <div class="split-line"></div>
            <div class="split-target">
              <div class="split-target-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>
              </div>
              <div class="split-target-name">Rust</div>
              <div class="split-target-desc">native binary · real FS · LLM providers</div>
            </div>
          </div>

          <div class="split-center">
            <div class="split-core">
              <SemaLogo height="32px" style="color: var(--text);" />
              <div class="split-core-sub">eval · stdlib · LLM</div>
            </div>
          </div>

          <div class="split-branch right">
            <div class="split-target">
              <div class="split-target-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div class="split-target-name">Browser (WASM)</div>
              <div class="split-target-desc">in-memory VFS · fetch() · no build step</div>
            </div>
            <div class="split-line"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: RUST EMBEDDING (side-by-side code, not feature-row) ============ -->
    <section id="rust">
      <div class="wrap">
        <p class="kicker">Rust embedding</p>
        <h2>Five lines to <em>a working interpreter.</em></h2>
        <p class="sub" style="margin-bottom: 36px">
          <code>Interpreter::new()</code> gives you the full stdlib and LLM
          support. <code>eval_str()</code> parses and evaluates. That's it.
          Use the builder for finer control — toggle stdlib, toggle LLM,
          configure the sandbox, restrict file paths.
        </p>

        <div class="dual-code">
          <div class="code-card">
            <div class="code-card-head">
              <span class="t">main.rs</span>
              <span class="n">quick start</span>
            </div>
            <pre><span class="c-kw">use</span> sema::{Interpreter, Value};

<span class="c-kw">fn</span> <span class="c-fn">main</span>() -> sema::Result<()> {
    <span class="c-kw">let</span> interp = Interpreter::new();
    <span class="c-kw">let</span> result = interp
        .eval_str(<span class="c-str">"(+ 1 2 3)"</span>)?;
    println!(<span class="c-str">"{result}"</span>); <span class="c-com">// 6</span>
    Ok(())
}</pre>
          </div>

          <div class="code-card">
            <div class="code-card-head">
              <span class="t">sandboxed.rs</span>
              <span class="n">builder API</span>
            </div>
            <pre><span class="c-kw">use</span> sema::{Interpreter, Sandbox, Caps};

<span class="c-kw">let</span> interp = Interpreter::builder()
    .without_llm()
    .with_sandbox(Sandbox::deny(
        Caps::SHELL
            .union(Caps::NETWORK)
            .union(Caps::FS_WRITE)
    ))
    .build();

interp.eval_str(<span class="c-str">"(+ 1 2)"</span>)?;
  <span class="c-com">// => 3 (always works)</span>
interp.eval_str(<span class="c-str">r#"(shell "ls")"#</span>)?;
  <span class="c-com">// => PermissionDenied</span></pre>
          </div>
        </div>

        <ul class="feature-list-inline">
          <li><strong>Builder API.</strong> <code>.with_stdlib()</code>, <code>.without_llm()</code>, <code>.with_sandbox()</code>, <code>.with_allowed_paths()</code> — only what you need.</li>
          <li><strong>Multiple interpreters.</strong> Each has fully isolated state — module cache, call stack, environment. Spin up as many as you want on the same thread.</li>
          <li><strong>Preload modules.</strong> <code>interp.preload_module("utils", source)</code> — inject virtual modules without a filesystem.</li>
        </ul>
      </div>
    </section>

    <!-- ============ FEATURE: SANDBOXING (capability grid) ============ -->
    <section id="sandbox">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Sandboxing</p>
            <h2>Nine capabilities. <em>Deny what you don't need.</em></h2>
            <p class="sub">
              Sandboxed functions remain discoverable and tab-completable — they
              return <code>PermissionDenied</code> when invoked. Path-restricted
              file operations confine I/O to specific directories with
              <code>..</code> traversal protection.
            </p>
            <ul class="feature-list">
              <li><strong>STRICT preset.</strong> Denies shell, fs-write, network, env-write, process, LLM, serial. Allows reads.</li>
              <li><strong>Path restriction.</strong> <code>.with_allowed_paths(vec!["./workspace"])</code> — canonicalizes and rejects traversal.</li>
              <li><strong>Graceful degradation.</strong> Denied functions are still visible — scripts can detect and adapt with <code>try/catch</code>.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="cap-grid">
              <div class="cap cap-denied">
                <span class="cap-name">SHELL</span>
                <span class="cap-desc">command execution</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">NETWORK</span>
                <span class="cap-desc">HTTP requests</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">FS_WRITE</span>
                <span class="cap-desc">file writes</span>
              </div>
              <div class="cap cap-allowed">
                <span class="cap-name">FS_READ</span>
                <span class="cap-desc">file reads</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">ENV_WRITE</span>
                <span class="cap-desc">env mutations</span>
              </div>
              <div class="cap cap-allowed">
                <span class="cap-name">ENV_READ</span>
                <span class="cap-desc">env access</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">PROCESS</span>
                <span class="cap-desc">process control</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">LLM</span>
                <span class="cap-desc">API calls</span>
              </div>
              <div class="cap cap-denied">
                <span class="cap-name">SERIAL</span>
                <span class="cap-desc">serial port</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: NATIVE FN REGISTRATION (dual: Rust + JS) ============ -->
    <section id="native-fns">
      <div class="wrap">
        <p class="kicker">Native function registration</p>
        <h2>Expose your functions <em>to the script.</em></h2>
        <p class="sub" style="margin-bottom: 36px">
          Register Rust closures or JavaScript functions — Sema scripts call
          them like any other function. Automatic value conversion both ways.
          Capture state in <code>Rc&lt;RefCell&lt;T&gt;&gt;</code> (Rust) or
          closures (JS).
        </p>

        <div class="dual-code">
          <div class="code-card">
            <div class="code-card-head">
              <span class="t">register.rs</span>
              <span class="n">Rust closure</span>
            </div>
            <pre><span class="c-com">// Simple function</span>
interp.register_fn(<span class="c-str">"add1"</span>, |args| {
    <span class="c-kw">let</span> n = args[0].as_int()
        .ok_or_else(|| {
            SemaError::type_error(
                <span class="c-str">"int"</span>, args[0].type_name())
        })?;
    Ok(Value::Int(n + 1))
});

<span class="c-com">// Captured state</span>
<span class="c-kw">let</span> counter = Rc::new(
    RefCell::new(0_i64));
<span class="c-kw">let</span> c = counter.clone();
interp.register_fn(<span class="c-str">"inc!"</span>, move |_| {
    *c.borrow_mut() += 1;
    Ok(Value::Int(*c.borrow()))
});</pre>
          </div>

          <div class="code-card">
            <div class="code-card-head">
              <span class="t">register.js</span>
              <span class="n">JS function</span>
            </div>
            <pre><span class="c-com">// Simple function</span>
interp.registerFunction(
  <span class="c-str">'add1'</span>, (n) => n + 1);

interp.evalGlobal(
  <span class="c-str">'(add1 41)'</span>).value;
<span class="c-com">// => "42"</span>

<span class="c-com">// Returning structured data</span>
interp.registerFunction(
  <span class="c-str">'get-user'</span>, (id) => {
    <span class="c-kw">return</span> JSON.stringify({
      name: <span class="c-str">"Alice"</span>, age: 30
    });
  });

interp.evalGlobal(
  <span class="c-str">'(:name (get-user 1))'</span>
).value;
<span class="c-com">// => "Alice"</span></pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: BROWSER & WASM (feature-row) ============ -->
    <section id="wasm">
      <div class="wrap">
        <div class="feature-row reverse">
          <div class="feature-text">
            <p class="kicker">Browser &amp; WASM</p>
            <h2>CDN-ready. <em>No build step.</em></h2>
            <p class="sub">
              Import from a CDN in a <code>&lt;script&gt;</code> tag.
              <code>new SemaInterpreter()</code> — that's it. <code>evalGlobal</code>
              for persistent definitions, <code>evalAsync</code> for HTTP via
              <code>fetch()</code>.
            </p>
            <ul class="feature-list">
              <li><strong>Async HTTP.</strong> <code>evalAsync</code> uses <code>fetch()</code> with a replay-with-cache strategy. Works on the main thread.</li>
              <li><strong>10M step limit.</strong> Infinite loops can't freeze the browser tab. Web Worker mode gets real blocking via <code>Atomics.wait</code>.</li>
              <li><strong>Live output streaming.</strong> <code>setOutputSink(fn)</code> streams <code>println</code> output line-by-line to the main thread in Worker mode.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">index.html</span>
                <span class="n">CDN, no build</span>
              </div>
              <pre><span class="c-com">&lt;!-- 30-second setup --&gt;</span>
&lt;<span class="c-kw">script</span> type=<span class="c-str">"module"</span>&gt;
  <span class="c-kw">import</span> init, { SemaInterpreter }
    <span class="c-kw">from</span> <span class="c-str">'https://cdn.jsdelivr.net/</span>
<span class="c-str">     npm/@sema-lang/sema-wasm/</span>
<span class="c-str">     sema_wasm.js'</span>;

  <span class="c-kw">await</span> init(<span class="c-str">'...sema_wasm_bg.wasm'</span>);
  <span class="c-kw">const</span> interp = <span class="c-kw">new</span> SemaInterpreter();

  <span class="c-kw">const</span> result = interp.evalGlobal(
    <span class="c-str">'(+ 40 2)'</span>);
  console.log(result.value);
  <span class="c-com">// => "42"</span>

  <span class="c-com">// Errors carry stack traces</span>
  <span class="c-kw">if</span> (result.error) {
    console.error(result.error);
  }
&lt;/<span class="c-kw">script</span>&gt;</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: VFS (feature-row) ============ -->
    <section id="vfs">
      <div class="wrap">
        <div class="feature-row">
          <div class="feature-text">
            <p class="kicker">Virtual filesystem</p>
            <h2>Files that <em>survive a reload.</em></h2>
            <p class="sub">
              The in-browser VFS lets scripts use <code>file/read</code> and
              <code>file/write</code> normally. Seed files from JavaScript,
              let scripts read them. Four built-in persistence backends, or
              plug in your own — S3, a REST API, a service worker cache.
            </p>
            <ul class="feature-list">
              <li><strong>Four backends.</strong> Memory (ephemeral), LocalStorage (per-origin), SessionStorage (per-tab), IndexedDB (hundreds of MB).</li>
              <li><strong>Custom backend interface.</strong> Implement <code>hydrate()</code> and <code>flush()</code> — sync to any remote store.</li>
              <li><strong>Quota-managed.</strong> 1 MB per file, 16 MB total, 256 files. <code>vfsStats()</code> reports usage.</li>
            </ul>
          </div>
          <div class="feature-visual">
            <div class="code-card">
              <div class="code-card-head">
                <span class="t">vfs.js</span>
                <span class="n">seed + load + persist</span>
              </div>
              <pre><span class="c-com">// Seed files from JS</span>
sema.writeFile(<span class="c-str">"/lib/math.sema"</span>,
  <span class="c-str">"(define (square x) (* x x))"</span>);

sema.writeFile(<span class="c-str">"/main.sema"</span>,
  <span class="c-str">'(import "/lib/math")</span>
<span class="c-str">   (square 7)'</span>);

<span class="c-com">// Script loads from VFS</span>
sema.evalGlobal(<span class="c-str">'(load "/main.sema")'</span>);
<span class="c-com">// => 49</span>

<span class="c-com">// Persist across reloads</span>
<span class="c-kw">import</span> { SemaInterpreter,
     IndexedDBBackend }
  <span class="c-kw">from</span> <span class="c-str">"@sema-lang/sema"</span>;

<span class="c-kw">const</span> sema = <span class="c-kw">await</span>
  SemaInterpreter.create({
    vfs: <span class="c-kw">new</span> IndexedDBBackend({
      namespace: <span class="c-str">"my-project"</span>
    })
  });</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FEATURE: DEV TOOLING (compact, no feature-row) ============ -->
    <section id="tooling">
      <div class="wrap">
        <p class="kicker">Developer tooling</p>
        <h2>LSP, DAP, and a debugger <em>in the box.</em></h2>
        <p class="sub" style="margin-bottom: 40px">
          The language server and debug adapter ship with the binary — no
          external plugins to install. Any editor that speaks LSP/DAP gets full
          IDE support. The WASM bindings expose a headless debugger for
          in-browser stepping, breakpoints, and variable inspection.
        </p>

        <div class="tooling-grid">
          <div class="tooling-card">
            <div class="tooling-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div class="tooling-name">LSP Server</div>
            <div class="tooling-features">
              <span>completions</span><span>hover</span><span>go-to-def</span><span>rename</span><span>format</span><span>code lens</span>
            </div>
            <div class="tooling-editors">Neovim · Helix · Zed · Emacs · Sublime</div>
          </div>

          <div class="tooling-card">
            <div class="tooling-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </div>
            <div class="tooling-name">DAP Debugger</div>
            <div class="tooling-features">
              <span>breakpoints</span><span>step in/out</span><span>step over</span><span>locals</span><span>stack trace</span><span>watch</span>
            </div>
            <div class="tooling-editors">VS Code · Helix · Neovim · Emacs</div>
          </div>

          <div class="tooling-card">
            <div class="tooling-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
            </div>
            <div class="tooling-name">WASM Headless Debugger</div>
            <div class="tooling-features">
              <span>debugStart</span><span>debugStepInto</span><span>debugGetLocals</span><span>debugGetStackTrace</span><span>debugSetBreakpoints</span><span>debugPoll</span>
            </div>
            <div class="tooling-editors">Browser playground · custom IDEs</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ WHAT'S IN THE BOX ============ -->
    <section id="whats-included">
      <div class="wrap">
        <p class="kicker">What's in the box</p>
        <h2>One dependency. <em>Everything included.</em></h2>
        <p class="sub" style="margin-bottom: 40px">
          The stdlib ships with JSON, HTTP, regex, file I/O, crypto, and more.
          LLM primitives are built in. LSP and DAP ship with the binary. The
          WASM target brings it to the browser. No extra dependencies to
          evaluate, wire up, or maintain.
        </p>

        <div class="included-grid">
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">JSON / CSV / TOML</div>
            <div class="included-desc">Parse and serialize out of the box</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">HTTP client</div>
            <div class="included-desc">Synchronous in Rust, fetch() in WASM</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">Regex</div>
            <div class="included-desc">Pattern matching, no crate to add</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">File I/O</div>
            <div class="included-desc">Real FS in Rust, VFS in browser</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">LLM primitives</div>
            <div class="included-desc">complete, chat, extract, embed, rerank</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">LSP server</div>
            <div class="included-desc">Completions, hover, go-to-def, rename</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">DAP debugger</div>
            <div class="included-desc">Breakpoints, stepping, variable inspection</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">WASM target</div>
            <div class="included-desc">CDN-ready, in-browser VFS, headless debugger</div>
          </div>
          <div class="included-card">
            <div class="included-icon">&#x2713;</div>
            <div class="included-name">Sandbox</div>
            <div class="included-desc">9 capability flags, path restriction</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ CTA ============ -->
    <section class="cta">
      <div class="wrap">
        <h2>Embed it in 30 seconds.</h2>
        <p class="sub">Two install paths. Same language. Same primitives.</p>
        <div class="install-stack">
          <div class="install-row">
            <span class="badge">rust</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i2">cargo add sema-lang</span>
              </span>
              <button class="copy" @click="copyText('i2', $event)">copy</button>
            </span>
          </div>
          <div class="install-row">
            <span class="badge">js</span>
            <span class="install">
              <span class="cmd-text">
                <span class="dollar">$</span>
                <span id="i3">npm i @sema-lang/sema</span>
              </span>
              <button class="copy" @click="copyText('i3', $event)">copy</button>
            </span>
          </div>
          <div class="hero-actions" style="justify-content:center; margin-top:24px">
            <a class="btn btn-gold" href="/docs/embedding">Rust embedding docs</a>
            <a class="btn btn-ghost" href="/docs/embedding-js">JS embedding docs</a>
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

/* ---------- split diagram (unique to this page) ---------- */
.split-showcase { padding: 0 0 88px; border-top: none; }

.split-diagram {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  margin-top: 48px;
}

.split-center {
  flex-shrink: 0;
  z-index: 2;
}

.split-core {
  background: var(--gold-fade);
  border: 1px solid var(--gold-line);
  border-radius: 14px;
  padding: 18px 24px;
  text-align: center;
  box-shadow: 0 0 24px rgba(200, 168, 85, 0.08);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.split-core-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.split-branch {
  flex: 1;
  display: flex;
  align-items: center;
}

.split-branch.left { justify-content: flex-end; }
.split-branch.right { justify-content: flex-start; }

.split-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold-line), transparent);
}

.split-branch.left .split-line { margin-right: 24px; }
.split-branch.right .split-line { margin-left: 24px; }

.split-target {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 24px;
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  min-width: 200px;
}

.split-target-icon { color: var(--gold); }

.split-target-name {
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--text);
}

.split-target-desc {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--dim);
  text-align: center;
}

/* ---------- dual code blocks (unique to this page) ---------- */
.dual-code {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 32px;
}

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
  line-height: 1.6;
  padding: 18px 20px;
  overflow-x: auto;
  color: #c9c2b4;
}

/* ---------- inline feature list (after dual-code) ---------- */
.feature-list-inline {
  margin-top: 28px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.feature-list-inline li {
  font-size: 13.5px;
  color: var(--muted);
  line-height: 1.6;
}
.feature-list-inline strong { color: var(--text); font-weight: 500; display: block; margin-bottom: 2px; }
.feature-list-inline code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--gold-bright);
  background: var(--gold-fade);
  padding: 1px 5px;
  border-radius: 4px;
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

/* ---------- capability grid (unique to this page) ---------- */
.cap-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.cap {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cap-denied {
  border-color: rgba(201, 123, 106, 0.18);
  background: rgba(201, 123, 106, 0.02);
}
.cap-allowed {
  border-color: rgba(155, 184, 122, 0.18);
  background: rgba(155, 184, 122, 0.02);
}
.cap-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
}
.cap-denied .cap-name { color: #c97b6a; }
.cap-allowed .cap-name { color: #9bb87a; }
.cap-desc {
  font-size: 11px;
  color: var(--dim);
}

/* ---------- tooling grid (unique to this page) ---------- */
.tooling-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.tooling-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tooling-icon { color: var(--gold); }
.tooling-name {
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--text);
}
.tooling-features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tooling-features span {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--gold-bright);
  background: var(--gold-fade);
  border-radius: 4px;
  padding: 3px 8px;
}
.tooling-editors {
  font-size: 11.5px;
  color: var(--dim);
  margin-top: auto;
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

/* ---------- what's included grid ---------- */
.included-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.included-card {
  background: var(--bg-raise);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.included-icon {
  color: #9bb87a;
  font-size: 15px;
  margin-bottom: 2px;
}
.included-name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--gold-bright);
}
.included-desc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

/* ---------- responsive ---------- */
@media (max-width: 880px) {
  .hero { padding: 72px 0 48px; }
  .feature-row, .feature-row.reverse { grid-template-columns: 1fr; }
  .feature-row.reverse .feature-text { order: unset; }
  .feature-row.reverse .feature-visual { order: unset; }
  .dual-code { grid-template-columns: 1fr; }
  .feature-list-inline { grid-template-columns: 1fr; }
  .cap-grid { grid-template-columns: repeat(2, 1fr); }
  .tooling-grid { grid-template-columns: 1fr; }
  .included-grid { grid-template-columns: 1fr; }
  .split-diagram { flex-direction: column; gap: 24px; }
  .split-branch { flex-direction: column; gap: 16px; }
  .split-branch.left, .split-branch.right { justify-content: center; }
  .split-line { width: 1px; height: 24px; background: linear-gradient(180deg, transparent, var(--gold-line), transparent); margin: 0 !important; }
}
</style>
