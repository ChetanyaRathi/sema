---
outline: [2, 3]
---

# Backend Compatibility

By default Sema labels its telemetry with the
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions/tree/main/docs/gen-ai)
— the standard `gen_ai.*` attribute names. Tools that follow that standard understand
Sema's traces with no extra configuration.

A handful of popular LLM-observability tools don't read `gen_ai.*` — they look for their
own attribute names instead, so a Sema span can show up in them as "unknown" or with
blank fields. For those tools, set the `SEMA_OTEL_COMPAT` environment variable and Sema
*also* writes their attribute names (in addition to the standard ones). Nothing about your
program changes — it's still the same automatic tracing, just labelled so more tools can
read it.

This is purely additive: the standard `gen_ai.*` attributes are always present;
`SEMA_OTEL_COMPAT` only adds extra copies under other names. Read the
[Tracing & Metrics](./observability) page first for how tracing works and how to point
Sema at a backend — this page only covers the per-tool labelling.

## Which tools need it

This list covers the tools that can **receive** OpenTelemetry traces. Most of them read
the standard `gen_ai.*` attributes and need no value at all; a handful use their own
attribute names and need a `SEMA_OTEL_COMPAT` token. (Tools that ingest only through
their own SDK or proxy can't receive an OTLP push at all — see
[Tools you can't send traces to](#tools-you-can-t-send-traces-to).)

### Works with no token

These read the standard `gen_ai.*` attributes directly:

| Tool | Self-hostable? | Notes |
| --- | --- | --- |
| Grafana / Tempo, [Jaeger](https://www.jaegertracing.io/) | yes | plain OpenTelemetry trace viewers |
| [SigNoz](https://signoz.io/) | yes | OTLP on 4317 / 4318 |
| [OpenObserve](https://openobserve.ai/) | yes | OTLP `/api/{org}/v1/traces` *(verified)* |
| [OpenLIT](https://openlit.io/) | yes | OTel-native; `docker run openlit/openlit` |
| [MLflow](https://mlflow.org/) | yes | the MLflow server exposes an OTLP `/v1/traces` endpoint |
| [Logfire](https://pydantic.dev/logfire) | — | Pydantic's OTel platform |
| Honeycomb, Elastic | partly | general OTel APM |
| Datadog LLM Observability | no | reads the GenAI conventions natively |
| [New Relic](https://newrelic.com/), [Dynatrace](https://www.dynatrace.com/), [Coralogix](https://coralogix.com/) | partly | APM platforms with native GenAI ingest |
| [Portkey](https://portkey.ai/), [HoneyHive](https://honeyhive.ai/) | no | OTLP endpoint, GenAI conventions |

### Works better with a token

These read OTLP but key off their own attribute names, so a token fills in the detail:

| Tool | `SEMA_OTEL_COMPAT` token | What the token adds |
| --- | --- | --- |
| [Arize Phoenix](https://phoenix.arize.com/), [Arize AX](https://arize.com/), [FutureAGI](https://futureagi.com/) | `openinference` | span types, model/provider, tokens, cost, message I/O, tool args + schemas |
| [Langfuse](https://langfuse.com/) | `langfuse` | observation type/model, usage + cost detail, trace-level input/output, tags |
| [Traceloop](https://www.traceloop.com/), [Laminar](https://www.lmnr.ai/), [LangWatch](https://langwatch.ai/), [Agenta](https://agenta.ai/) | `traceloop` | span types, entity input/output, indexed token keys, tool functions |
| [LangSmith](https://www.langchain.com/langsmith) | `langsmith` | run types, session threading, tags/metadata |
| [Braintrust](https://www.braintrust.dev/) | `braintrust` *(optional)* | native tags, metadata, and cost fields (it also reads `gen_ai.*` on its own) |

> A few tools (Galileo, PromptLayer, Keywords AI, Arthur AI, W&B Weave) advertise
> "OpenTelemetry support" but don't clearly document a public OTLP trace endpoint that
> reads `gen_ai.*`. They may work, but we haven't confirmed them — try the standard
> setup and check whether your spans appear.

## Setting `SEMA_OTEL_COMPAT`

It's an environment variable like the others (see
[How to turn it on](./observability#how-to-turn-it-on)). Its value is a comma-separated
list of the tool names from the table above, lower-case:

```bash
# Just Phoenix:
SEMA_OTEL_COMPAT=openinference sema myagent.sema

# Phoenix and Langfuse at once:
SEMA_OTEL_COMPAT=openinference,langfuse sema myagent.sema

# Every supported tool's names — useful if you're not sure which backend you'll use:
SEMA_OTEL_COMPAT=all sema myagent.sema
```

Accepted values: `openinference` (also `phoenix`, `arize`), `traceloop` (also
`openllmetry`), `langsmith`, `langfuse`, `braintrust`, and `all`. Names you don't
recognise are ignored, so a typo won't break anything.

Some of the added detail — message text, tool arguments and results, and the trace-level
input/output summary — is **content**, so it only appears when you also turn on content
capture with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (see
[Privacy](./observability#privacy)). Token counts, models, cost, and span types are
always added.

When `SEMA_OTEL_COMPAT` is unset, no extra attributes are written — the traces are exactly
what you get on the [Tracing & Metrics](./observability) page.

## Per-tool setup

### Arize Phoenix (OpenInference)

Phoenix is an open-source LLM trace viewer that runs in one container:

```bash
# Start Phoenix. UI on 6006; it accepts traces on 6006 (HTTP) and 4317 (gRPC).
docker run -d --name phoenix -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest

SEMA_OTEL_COMPAT=openinference \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006 \
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
  sema -e '(llm/complete "say hi" {:max-tokens 16})'
```

Open `http://localhost:6006`. Each Sema span is typed (`LLM` / `TOOL` / `AGENT` /
`EMBEDDING`) and shows the model, provider, token counts, cost, the message I/O, and —
for agent runs — tool arguments, results, and the tool schemas offered to the model.

### Langfuse

Langfuse already reads several of Sema's standard attributes (cost and message I/O). The
`langfuse` value fills in the rest — the observation type and model, the usage/cost detail
objects, and the trace-level input/output summary:

```bash
SEMA_OTEL_COMPAT=langfuse \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/api/public/otel" \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 of publickey:secretkey>" \
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
  sema myagent.sema
```

(See the [Langfuse example](./observability#sending-to-hosted-langfuse) for how to build
the auth header.) Multi-turn runs group into
[Sessions](./observability#sessions-and-users-grouping-multi-turn-runs) via the
`:session-id` and `:user-id` options.

### Traceloop (OpenLLMetry)

Traceloop is mainly a hosted product, but it reads plain OTLP, so you can also view the
output in any OTLP backend (such as SigNoz). `SEMA_OTEL_COMPAT=traceloop` adds the
`traceloop.span.kind` and `traceloop.entity.*` attributes, the indexed token keys, and the
advertised tool functions.

### LangSmith

LangSmith ingests over OTLP but has no local/self-hosted option, so point Sema at its
hosted endpoint with your API key and `SEMA_OTEL_COMPAT=langsmith`. This adds LangSmith's
run types, session threading, and tags/metadata.

### Braintrust

Braintrust reads the standard attributes, so it works with no value set. Add `braintrust`
only if you want its native `braintrust.tags` and `braintrust.metadata` fields.

## Span-type mapping

How each Sema span is labelled for each tool when its compat value is on:

| Sema span | OpenInference | Traceloop | LangSmith | Langfuse |
| --- | --- | --- | --- | --- |
| `chat` | `LLM` | `task` | `llm` | `generation` |
| `embeddings` | `EMBEDDING` | `task` | `embedding` | `generation` |
| `execute_tool` | `TOOL` | `tool` | `tool` | `span` |
| `invoke_agent` | `AGENT` | `agent` | `chain` | `span` |
| notebook cell / retry | `CHAIN` | `workflow` | `chain` | `span` |

## Tools you can't send traces to

Many LLM tools collect data a different way — through their own client SDK, by sitting in
front of your API calls as a proxy, or by running offline evaluations — rather than by
receiving OpenTelemetry traces. Sema's OTLP export can't feed those; to use one, follow
its own integration guide instead. The main categories:

- **Proxies / gateways** — capture by routing your model calls through them, not by
  accepting traces: [Helicone](https://www.helicone.ai/),
  [LiteLLM](https://litellm.ai/), [Portkey gateway](https://portkey.ai/) (its
  *observability* endpoint does accept OTLP — see the table above), [Pezzo](https://pezzo.ai/).
- **SDK-only platforms** — ingest through their own Python/JS library, with no OTLP trace
  endpoint: [Opik](https://www.comet.com/opik), [Lunary](https://lunary.ai/),
  [Vellum](https://www.vellum.ai/), [Athina AI](https://athina.ai/),
  [Parea AI](https://www.parea.ai/), [PostHog](https://posthog.com/) (LLM analytics events),
  [Nebuly](https://www.nebuly.com/), [Humanloop](https://humanloop.com/),
  [Maxim AI](https://www.getmaxim.ai/), [Fiddler AI](https://www.fiddler.ai/),
  [W&B Weave](https://wandb.ai/) (accepts OTLP but is built around its own SDK).
- **Evaluation-only** — offline scoring/testing, not a runtime trace receiver:
  [Promptfoo](https://www.promptfoo.dev/), [DeepEval](https://www.deepeval.com/),
  [RAGAS](https://docs.ragas.io/), [Patronus AI](https://www.patronus.ai/),
  [UpTrain](https://uptrain.ai/), [Evidently AI](https://www.evidentlyai.com/),
  [Giskard](https://www.giskard.ai/), [Confident AI](https://www.confident-ai.com/),
  [TruLens](https://www.trulens.org/).
- **Guardrails libraries** that *emit* telemetry rather than receive it:
  [NVIDIA NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails),
  [Guardrails AI](https://www.guardrailsai.com/).

If a tool here later adds an OTLP endpoint that reads the GenAI conventions, Sema will
work with it the same as the others — no change needed on Sema's side.

## Limitations

- **Message content requires the opt-in flag.** The message I/O, tool arguments and
  results, and the trace-level input/output only appear when
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`. Token counts, models, cost,
  and span types are always added.
- **OpenInference has no separate tool-result field** — the result appears in the tool
  span's `output.value` rather than a dedicated attribute.
- **LangSmith recomputes cost** on its side from the token counts, so Sema's exact
  per-call cost (including cache pricing) may differ from the number LangSmith shows.
- **Helicone** is a proxy/gateway, not an OTLP receiver, so this setting can't send traces
  to it. Use Helicone's own gateway integration instead.
- **Not yet implemented:** streaming time-to-first-token, and the per-message *indexed*
  attribute form some older Traceloop/LangSmith parsers expect (Sema emits the structured
  and entity forms today). An auto-tagging option is also planned.
- **More attributes per span.** Compat adds extra copies of each value. If you only use a
  plain OTel backend, leave `SEMA_OTEL_COMPAT` unset to keep spans lean.
