# CLI Tracing and Monitoring

Every CLI run can produce one span tree rooted at `cli.run`. Use it to find where time goes in a
command. Tracing is off unless you turn it on for a run; the conventions for adding spans live in
[ADR 0027](../../../docs/adr/0027-cli-tracing-conventions.md).

For product analytics and command usage events, see [analytics.md](./analytics.md).

## Turning tracing on

Pick one destination per run:

| Variable                 | Effect                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| `SUPABASE_TRACE_FILE`    | Appends one OTLP/JSON batch per line to this file (`0600` when allowed). |
| `SUPABASE_OTLP_ENDPOINT` | Posts OTLP/HTTP JSON to `<endpoint>/v1/traces`.                          |
| `SUPABASE_OTLP_HEADERS`  | Extra collector headers as `key=value,key2=value2` (percent-encoded).    |
| `TRACEPARENT`            | W3C trace context adopted as the parent of `cli.run` when a sink is set. |

Tracing never stops a command. When both `SUPABASE_TRACE_FILE` and `SUPABASE_OTLP_ENDPOINT` are
set, the endpoint or headers are malformed, or the sink cannot start (for example, the trace
file's directory is missing or the path is not a regular file, such as `/dev/null`), the CLI
prints one `Warning: tracing disabled: <reason>` line on stderr and runs the command untraced with
the same exit code and stdout. A relative `SUPABASE_TRACE_FILE` resolves against the directory the
CLI started in. The generic `OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME`, and
`OTEL_RESOURCE_ATTRIBUTES` variables are ignored. A sink records the run even when `TRACEPARENT`
is marked unsampled.

`SUPABASE_DEBUG=1` or `SUPABASE_TELEMETRY_DEBUG=1`, set in the environment or the project's
`supabase/.env`, also prints finished command spans to stderr: top-level spans, their children and
grandchildren, plus every failed span at any depth. Spans that end before CLI settings load, and
`cli.run` itself, are not printed. The `--debug` flag does not print spans.

Without a sink or debug variable, spans are no-ops and the CLI does no tracing I/O.

## Local trace file

```sh
SUPABASE_TRACE_FILE=/tmp/supabase-trace.jsonl supabase db diff
bun apps/cli/scripts/trace-report.ts /tmp/supabase-trace.jsonl
```

The report prints the heaviest path from `cli.run`, the top span names by self time, repeated span
names with counts and total time, and failed spans. Docker and Podman spans are labeled with their
verb, such as `ContainerCli.spawn (run)`. Pass `--top N` to change list lengths and
`--json` for machine-readable output. The file appends across runs; the report covers the run that
ended last, or the one passed with `--trace-id`.

## Benchmarking

`apps/cli/scripts/bench-cli.ts` compares wall time between two CLI binaries, for example a release
build against a branch build:

```sh
bun apps/cli/scripts/bench-cli.ts --base /tmp/cli-base/apps/cli/dist/supabase --branch apps/cli/dist/supabase \
  --runs 10 --warmup 2 --command "--version" --command "status" --cwd-setup init --trace
```

It alternates launches (`base`, `branch`, `base`, `branch`, ...) so neither binary runs consistently
warmer, discards the first `--warmup` pairs, and gives each launch an isolated `SUPABASE_HOME` and
environment. For each command it reports the base and branch median, min, max, and p90 wall time in
milliseconds, plus the branch-minus-base delta in ms and percent. With `--trace`, each measured
launch is followed by an untimed launch with `SUPABASE_TRACE_FILE` set, so tracing never inflates
the wall times, and the report adds, per span name, the median total duration and count for
each build, sorted by the largest absolute delta; a span name present in only one build is flagged
rather than compared. `--command` splits on whitespace and does not support shell quoting; repeat the
flag for more than one command, and use `--cwd-setup init` when a command, such as `status`, needs to
run inside an initialized project. Pass `--json` for a machine-readable report, `--out <file>` to
also write the raw per-run samples, and `--cpu-prof` to capture a Bun CPU profile of one untimed
branch launch (`BUN_OPTIONS=--cpu-prof`), printing its `.cpuprofile` path. Launches set
`SUPABASE_NO_UPDATE_NOTIFIER=1`, because the release check calls GitHub on every run outside a
project; pass `--update-check` to include it. The extra traced launches add machine load, so take
wall-time conclusions from a run without `--trace`.

To build a base binary from another commit without disturbing this worktree:

```sh
mkdir /tmp/cli-base && git archive <sha> | tar -x -C /tmp/cli-base
rm -f /tmp/cli-base/mise.toml /tmp/cli-base/mise.lock # if mise refuses the untrusted config
(cd /tmp/cli-base && pnpm install && pnpm exec turbo run supabase#build)
```

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

- Resource: `service.name=supabase-cli`, `service.version`, `os`, `arch`, `is_ci`,
  `service.instance.id` (a random id per run).
- `cli.run`: `process.boot_ms`, the time from process start to CLI entry, and
  `process.exit_code`, the code the CLI exits with. A non-zero code ends `cli.run` with error
  status and a `CliNonZeroExit` exception type.
- Failed spans: `error.type`, the failing error's tag, when it has one.
- Command span (`command.<path>`): `command` and `command_run_id`. When telemetry consent is
  granted, also `device_id`, `session_id`, and `is_first_run`.
- Layer spans such as `CliSettings.load`, `CliProjectContext.load`, and `ProjectLinkState.load`.
- HTTP client spans with method, host, path, status, and allowlisted headers.
- Process spans with the executable basename, argument count, exit code, and for docker or
  podman the verb (such as `container inspect`). Children receive a
  `TRACEPARENT` pointing at their span when a sink is active.

## What is removed before export

Traces carry no free-form error or log text. Every batch and every console line is sanitized:

- Exception events keep only `exception.type`, the error class or tag name such as `SqlError`; a
  name that is not an identifier is exported as `Error`. Error messages and stack traces are
  dropped. A failed span records the Postgres SQLSTATE, when the error carries one, as
  `db.response.status_code`.
- Span status messages are dropped; the status code remains.
- Log events are renamed `log` and keep only `effect.logLevel`.
- `db.query.text` is replaced by `db.operation.name`, `db.query.hash`, and `db.query.length`. The
  hash is keyed by a random salt drawn once per run, so repeated statements share a hash within a
  run but hashes from different runs cannot be compared.
- `url.full` keeps only scheme, host, and path; `url.query` is dropped.
- Storage object paths in `url.full` and `url.path` keep the operation, such as `sign`, and replace
  the bucket and object name with `<redacted>`. Bucket routes (`/storage/v1/bucket/…` and
  `/storage/v1/iceberg/bucket/…`) replace the bucket name the same way.
- Only `content-type`, `content-length`, `user-agent`, `x-request-id`, `cf-ray`, and `retry-after`
  headers are kept.
- String values under keys that mention tokens, passwords, secrets, API keys, authorization, or
  cookies are dropped; numeric and boolean values such as counts are kept.
- Remaining string attributes lose URL credentials (everything before the last `@`), bearer tokens, JWTs, Supabase keys and access
  tokens, password pairs, single-quoted SQL literals, and constraint key values such as
  `Key (email)=(…)`, and are capped at 2 KB.

The terminal still shows the full error text.

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
