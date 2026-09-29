# 0027. CLI tracing conventions

**Status**: proposed
**Date**: 2026-09-29

## Problem Statement

Finding where a CLI run spends time used to need ad-hoc instrumentation per investigation. The old
tracer wrote consent-gated NDJSON without parent links, so nothing could rebuild a span tree from
it. The CLI needs one span tree per run that people and agents can read locally or in an
OpenTelemetry backend, costs nothing when unused, and never exports secrets.

## Decision

Each run produces one trace rooted at `cli.run`, exported to at most one sink:

- `SUPABASE_TRACE_FILE=<path>` appends one OTLP/JSON batch per line. The file is created with mode
  `0600`.
- `SUPABASE_OTLP_ENDPOINT=<base URL>` posts OTLP/HTTP JSON to `<base>/v1/traces`, with optional
  `SUPABASE_OTLP_HEADERS=k=v,k2=v2`.
- Setting both is a configuration error. Generic `OTEL_EXPORTER_OTLP_*` variables are ignored, so
  a global collector setting never receives CLI internals.
- `TRACEPARENT` becomes the parent of `cli.run` when a sink is active, and spawned processes
  receive a `TRACEPARENT` for their process span.
- `--debug` (or `SUPABASE_DEBUG=1`) prints finished spans up to depth 2 plus every failed span to
  stderr.

With no sink and no debug switch, the root runs with `References.TracerEnabled = false`. Spans are
Effect's no-op spans, no exporter module is loaded, and no trace file or network I/O happens.

Every exported batch and console line goes through `shared/telemetry/trace-sanitize.ts`:
`db.query.text` becomes `db.operation.name`, `db.query.hash`, and `db.query.length`; `url.full`
loses its query; `url.query` and non-allowlisted headers are dropped; credential-named keys are
dropped; remaining strings, exception events, and status messages are scrubbed and capped at 2 KB.
HTTP trace-header propagation is disabled for all CLI requests.

### Instrumentation rules

- Name spans `Area.operation` with low cardinality. Put ids, refs, and counts in attributes.
- Use `Effect.fn("Area.op")` only for functions that do I/O or millisecond-scale work. Use
  `Effect.withSpan` for phases inside a `gen` body and `Effect.annotateCurrentSpan` for counts,
  sizes, cache hit or miss, strategy, retry attempts, service or image names, project refs, and
  status or exit codes.
- Keep `Effect.fnUntraced` for pure helpers and anything called per item in a loop; `Effect.fn`
  captures a stack on every call even when tracing is off.
- Never annotate secrets, connection strings, environment values, file contents, argv, or query
  results. The sanitizer is a safety net, not a license.
- Do not create spans per row, byte, stream element, or poll iteration. Per-item spans are fine
  for bounded, heavy fan-outs such as migrations, services, functions, and images.
- Wrap child processes with `withProcessSpan` or `withProcessSpanScoped` from
  `shared/telemetry/spans.ts`, which record the executable basename, argument count, and exit code
  and pass `TRACEPARENT` to the child.
- Build layer spans with `Effect.withSpan` inside the `Layer.effect` constructor. `Layer.withSpan`
  keeps the span open until the scope closes.
- In `packages/api` call sites, name the span after the generated operation id where the path
  template is known and annotate `api.operation`; the HTTP span name generator only sees
  interpolated paths.

An integration test caps a representative command at 2,000 spans and 200 spans per name so a
per-item span in a hot loop fails CI.

## Consequences

- Tracing is opt-in per run and needs no telemetry consent: the user chooses the destination.
- Old `~/.supabase/traces/*.ndjson` files are no longer written or cleaned up; they are safe to
  delete.
- A traced point costs about 1 µs when tracing is off, so overhead grows with span count; the span
  budget test guards against hot-loop instrumentation.
- `runCli` closes the trace scope with a bounded, uninterruptible 2-second flush before
  `processControl.exit`, which skips finalizers.

## Alternatives Considered

- **Standard `OTEL_*` variables**: rejected because a developer's global collector configuration
  would silently export CLI internals.
- **Keeping the NDJSON exporter**: rejected because it lacked parent links and required a custom
  format; OTLP/JSON lines work with standard tools and the report script.
- **Sanitizing in span attribute setters**: rejected because exception events and status
  messages bypass attribute writes; sanitizing the serialized batch covers every field.

## References

- [Tracing and monitoring how-to](../../apps/cli/docs/tracing-monitoring.md)
- [ADR 0001, Pillar 5](0001-cli-dx-architecture-pillars.md)
