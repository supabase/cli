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

Without a sink or debug variable, spans are no-ops and the CLI does no tracing I/O. The
implementation lives in
[`src/shared/telemetry/trace-export.layer.ts`](../src/shared/telemetry/trace-export.layer.ts).

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
rather than compared. `--command` splits on whitespace and does not support shell quoting (use `--workloads` for quoted arguments); repeat the
flag for more than one command, and use `--cwd-setup init` when a command, such as `status`, needs to
run inside an initialized project. Pass `--json` for a machine-readable report, `--out <file>` to
also write the raw per-run samples, and `--cpu-prof` to capture a Bun CPU profile of one untimed
branch launch (`BUN_OPTIONS=--cpu-prof`), printing its `.cpuprofile` path. Launches set
`SUPABASE_NO_UPDATE_NOTIFIER=1`; pass `--update-check` to include the release check. Each launch's
fresh `SUPABASE_HOME` has no cached release tag, so the check calls GitHub on every launch, except
with `--cwd-setup init`, where the setup `init` caches the tag in the project before the measured
command runs. The extra traced launches add machine load, so take wall-time conclusions from a run
without `--trace`.

To build a base binary from another commit without disturbing this worktree:

```sh
mkdir /tmp/cli-base && git archive <sha> | tar -x -C /tmp/cli-base
rm -f /tmp/cli-base/mise.toml /tmp/cli-base/mise.lock # if mise refuses the untrusted config
(cd /tmp/cli-base && pnpm install && pnpm exec turbo run supabase#build)
```

### Pull request benchmark

`.github/workflows/cli-bench.yml` runs on every ready pull request into `develop` that touches the CLI, its packages, or
the e2e replay fixtures. It builds the pull request and the base tip it merges into with `pnpm --filter supabase run build:binary`, runs both
through `bench-cli.ts` against a local replay server, and writes a job summary with `bench-summary.ts`.
The job is report only: it never blocks a pull request, and a benchmark problem is reported in the
summary instead of failing the job: a failed branch or base build or a replay server that does not
start replaces the comparison with a notice naming the step. The workloads use no Docker, database, or network, and no
prompts.

The first push to a pull request from this repository benchmarks and posts one comment, tagged with
the hidden marker `<!-- cli-bench:pr -->`. Later pushes skip the benchmark, and the job summary says
so, while that comment reports a result; a comment that reports a failed run is benchmarked again
on the next push. Pull requests from forks have a read-only token, so they get the job summary only
and benchmark every push.

A maintainer can comment exactly `/bench` to run the benchmark again on the pull request's current
head commit. The command re-runs that commit's `pull_request` workflow run, as "Re-run all jobs" in
the Actions UI does, and the re-run updates the comment in place, or creates it if it is missing.
The comment keeps a collapsed "Previous runs" list below the report with the commit, time (UTC),
headline, and link of each earlier run, newest first and up to 20, stored in a hidden marker in the
comment. Only the repository owner and people with write access can run it, and only on open,
non-draft pull requests into `develop` from this repository; the command must be the whole comment,
so `/bench full` and anything else is ignored. An eyes reaction on the comment means GitHub accepted
the re-run and a benchmark is running; the result arrives as the updated benchmark comment, whether
it succeeded or failed. When no re-run can start, the pull request gets a reply saying why: a
benchmark is already running for the commit, the run is older than 30 days, GitHub refused the
re-run (the reply includes the status and message), or there is no run for the commit.

Known gap: a pull request whose changes match none of the workflow's path filters, or that changes
more files than GitHub's path filter inspects (300), gets no run, so there is nothing for `/bench`
to re-run and it replies that there is none.

Workflows triggered by comments run from the default branch, so `/bench` works only once the
workflow is on `develop`. The `/bench` job runs default branch code only: it never checks out or
runs pull request code, because a comment-triggered run shares the default branch's cache scope.
Benchmarks always run in the `pull_request` run. `resolve` (read-only) decides whether a push
benchmarks; `rerun` is the only job with `actions: write`. `bench` has read-only permissions, and
`comment` is the only `pull_request` job that can write to the pull request. It never builds or
runs the benchmarked binaries: it downloads the rendered markdown, sanitizes it, and posts it.

To run it locally with two binaries (for example builds from two commits):

```sh
pnpm --filter @supabase/cli-e2e run replay:serve   # prints {"url":"http://127.0.0.1:<port>"}
bun apps/cli/scripts/bench-cli.ts --base <base-binary> --branch <branch-binary> \
  --workloads apps/cli/bench/workloads.pr.json --api-url <url> --trace --out /tmp/report.json
bun apps/cli/scripts/bench-summary.ts --report /tmp/report.json
```

`--workloads` replaces repeated `--command` flags. `apps/cli/bench/workloads.pr.json` lists entries
with an `id`, an `args` array (so quoting works), a `cwdSetup` of `none` or `init`, and optionally
a replay `scenario`. `init` runs `supabase init` in the launch's project directory first. Setup runs
outside the timed region.

`--api-url` (which requires `--trace`) points every launch at the replay server by writing a profile
file into the launch's fresh `SUPABASE_HOME` and setting `SUPABASE_PROFILE`, plus a dummy access
token. The profile is the CLI's only API redirect: `SUPABASE_API_URL` does not change where the
Management API client sends requests, so it is never set. Every launch gets the profile, including
`--version` and `init`, so an unexpected new API call reaches the server and is counted. Before each
launch the harness clears the server's request log and scenario, then selects the workload's
scenario, so scenarios that are used up as they are served start fresh every time. A failing control
call aborts the benchmark. A launch that runs longer than 60 seconds is killed and counted as a
failed launch (exit code 124), so that workload is reported as not compared and the rest finish.

API calls are counted from the traced launch's HTTP client spans: spans to the `--api-url` host and
port are API calls, and spans to any other host are `externalCalls`. The count is cross-checked
against the replay server's request log for the same launch. The `--out` file stores raw per-run
data; the summary derives medians, flags, and verdicts from it, so thresholds can change without
re-running.

The report (the comment and the job summary share one renderer) leads with the answer, "no changes
found" or "N things to check", then one plain-words line for each flag, a table of the median time
per command before and after the change, API calls, and the binary size. A collapsed section holds
the timing ranges, API calls per command, and the slowest phases. It reports:

- Flags: an API call count that goes from 0 to more than 0 (for example `migration new` starting to
  call the API) or from more than 0 to 0, calls to hosts other than the replay server, counts that
  differ between runs of one build, spans that disagree with the request log, 4xx/5xx replay
  responses (the build did not follow the recorded scenario), non-zero or differing exit codes,
  missing traces, and too few runs for a timing verdict. Other count changes, such as 1 to 2 calls, appear in the API calls table with the
  changed endpoints but are not flagged.
- Wall time: base ("before") and branch ("after") medians and ranges. A verdict of slower or faster needs the branch
  median outside the base min-max range, a change of at least 5 percent and 5 ms, and at least 5
  measured runs; otherwise it reads "within noise", or "not comparable" when a build failed.
  Thresholds are named constants in `bench-report.ts`.
- API calls per workload, base and branch.
- Phase deltas: the three largest span deltas for each workload with a slower or faster verdict.
- Binary size of `dist/supabase`.

The baseline API calls per workload on `develop` (a project-scoped command
also refreshes the linked-project cache, so it makes two calls):

| Workload                                   | API calls                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `version`, `help`, `init`, `migration-new` | 0                                                                      |
| `projects-list`                            | 1: `GET /v1/projects`                                                  |
| `gen-types`                                | 2: `GET /v1/projects/{ref}/types/typescript`, `GET /v1/projects/{ref}` |
| `functions-list`                           | 2: `GET /v1/projects/{ref}/functions`, `GET /v1/projects/{ref}`        |

`SUPABASE_NO_KEYRING=1` disables the keyring (`CommandCredentials.load` reports
`keyring.enabled=false`); the value `true` is not recognized. Counts come from the untimed traced
launch, so a launch that behaves differently when timed shows up only as an exit-code difference.

#### How the workloads were chosen

The list comes from `cli_command_executed` usage in PostHog over the last 30 days, for stable CLI
versions only (prereleases excluded). Commands are ranked by distinct `device_id`, then by run
count; the p50 and p90 duration of successful runs, the CI share, and the agent share are context.
Only commands that run with no Docker, no database, no real network, and no prompts are kept, and
every Go-proxied command is dropped. One command is taken from each class (startup, local files,
API read without a ref, API calls with a ref, API read of a large response) rather than the top N
overall, capped to fit the time budget. Refresh the list each quarter, or after the
v3 release with the version regex updated:

```sql
SELECT properties.command cmd, uniq(properties.device_id) users, count() runs,
 round(100*countIf(properties.exit_code != 0)/count(),1) err_pct,
 round(quantileIf(0.5)(properties.duration_ms, properties.exit_code = 0)) p50_ms,
 round(quantileIf(0.9)(properties.duration_ms, properties.exit_code = 0)) p90_ms,
 round(100*countIf(properties.is_ci = true)/count(),1) ci_pct,
 round(100*countIf(properties.is_agent = true)/count(),1) agent_pct
FROM events WHERE event='cli_command_executed' AND timestamp >= now() - INTERVAL 30 DAY
 AND match(properties.cli_version,'^2\\.(119|120|121|122)\\.[0-9]+$')
GROUP BY cmd ORDER BY users DESC LIMIT 40
```

Caveats:

- Telemetry records the command path and the flags set on the command line, with values redacted
  unless the flag is boolean, a choice, or listed in the command's `safeFlags` (see
  [analytics.md](analytics.md)); positional arguments and free-form values are not recorded, so
  `bench` and the TypeScript target only approximate real use.
- `device_id` counts machines, not people, short-lived CI runners inflate it, and a large share of
  runs come from agents. Telemetry durations include network, Docker, and wait time, so they guided
  the choice but are not what the benchmark measures.
- Excluded high-usage commands: `start`, `status`, `stop`, `db start`, `db reset`, and `test db`
  need Docker; `db push`, `db lint`, `db dump`, `db diff`, `migration list`, `migration up`,
  `migration repair`, and `db schema declarative sync` need a database (a nightly tier);
  `link` probes `https://<ref>.<project_host>`, which never reaches the replay server;
  `functions deploy` uses Docker by default and its API path has no success scenario; `login` is
  interactive unless a token is passed; `functions serve` needs Docker.
- The first launch of a process is slower (credential loading); the warm-up runs absorb it.
- Launches write a profile file, so numbers from runs with `--api-url` are not comparable with runs
  without it.

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
- `UpgradeNotice.check`, the post-command release check: `cache.location` (`project`, `user`, or
  `disabled` when a symlink blocks the cache) and `cache.hit`. A cache miss adds an
  `UpgradeNotice.fetch` child for the GitHub request.
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
