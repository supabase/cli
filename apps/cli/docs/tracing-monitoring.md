# CLI Tracing and Monitoring

Every CLI run can produce one span tree rooted at `cli.run`. Use it to find where time goes in a
command. Tracing is off unless you turn it on for a run; the conventions for adding spans live in
[ADR 0027](../../../docs/adr/0027-cli-tracing-conventions.md).

For product analytics and command usage events, see [analytics.md](./analytics.md).

## Turning tracing on

Pick one destination per run:

| Variable                 | Effect                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| `SUPABASE_TRACE_FILE`    | Appends one OTLP/JSON batch per line to this file (created with `0600`). |
| `SUPABASE_OTLP_ENDPOINT` | Posts OTLP/HTTP JSON to `<endpoint>/v1/traces`.                          |
| `SUPABASE_OTLP_HEADERS`  | Extra collector headers as `key=value,key2=value2` (percent-encoded).    |
| `TRACEPARENT`            | W3C trace context adopted as the parent of `cli.run` when a sink is set. |

Setting both `SUPABASE_TRACE_FILE` and `SUPABASE_OTLP_ENDPOINT` fails the run with a
configuration error. The generic `OTEL_EXPORTER_OTLP_*` variables are ignored.

`--debug`, `SUPABASE_DEBUG=1`, or `SUPABASE_TELEMETRY_DEBUG=1` also prints finished spans to stderr:
the root, its children and grandchildren, plus every failed span at any depth.

Without any of these, spans are no-ops and the CLI does no tracing I/O.

## Local trace file

```sh
SUPABASE_TRACE_FILE=/tmp/supabase-trace.jsonl supabase db diff
bun apps/cli/scripts/trace-report.ts /tmp/supabase-trace.jsonl
```

The report prints the heaviest path from `cli.run`, the top span names by self time, repeated span
names with counts and total time, and failed spans. Pass `--top N` to change list lengths and
`--json` for machine-readable output. The file appends across runs; delete it to start fresh.

## Grafana, Tempo, or Jaeger

Run a local OpenTelemetry stack, for example Grafana's all-in-one image:

```sh
docker run --rm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
SUPABASE_OTLP_ENDPOINT=http://localhost:4318 supabase start
```

Open Grafana at `http://localhost:3000`, choose the Tempo data source, and search with TraceQL:

```text
{ resource.service.name = "supabase-cli" && name = "cli.run" }
{ resource.service.name = "supabase-cli" && duration > 1s }
{ resource.service.name = "supabase-cli" && status = error }
```

Any collector that accepts OTLP/HTTP JSON works; pass credentials with `SUPABASE_OTLP_HEADERS`.

## What a trace contains

- Resource: `service.name=supabase-cli`, `service.version`, `os`, `arch`, `is_ci`.
- `cli.run`: `process.boot_ms`, the time from process start to CLI entry.
- Command span (`command.<path>`): `command`, `command_run_id`, `device_id`, `session_id`,
  `is_first_run`.
- Layer spans such as `CliSettings.load`, `CliProjectContext.load`, and `ProjectLinkState.load`.
- HTTP client spans with method, host, path, status, and allowlisted headers.
- Process spans with the executable basename, argument count, exit code, and for docker or
  podman the verb (such as `container inspect`). Children receive a
  `TRACEPARENT` pointing at their span when a sink is active.

## What is removed before export

Every batch and every console line is sanitized:

- `db.query.text` is replaced by `db.operation.name`, `db.query.hash`, and `db.query.length`.
- `url.full` keeps only scheme, host, and path; `url.query` is dropped.
- Only `content-type`, `content-length`, `user-agent`, `x-request-id`, `cf-ray`, and `retry-after`
  headers are kept.
- Keys that mention tokens, passwords, secrets, API keys, authorization, or cookies are dropped.
- Remaining strings, including exception messages, stack traces, and status messages, lose URL
  credentials, bearer tokens, JWTs, Supabase keys and access tokens, and password pairs, and are
  capped at 2 KB.

HTTP requests never carry `traceparent` or `b3` headers.

## Lifecycle

The trace scope closes before the process exits. The final flush is uninterruptible and capped at
2 seconds, so a slow collector cannot hold the CLI open. The file sink always acknowledges a
batch, so a local write failure never triggers retries or duplicate lines.

## Old trace files

Earlier versions wrote NDJSON files under `SUPABASE_HOME/traces/`. The CLI no longer writes or
cleans that directory; it is safe to delete.

## What tracing is not

Tracing is not used for product analytics funnels, command adoption reporting, organization or
project analytics, or milestone events such as `cli_login_completed`. Those belong to the
analytics path described in [analytics.md](./analytics.md).
