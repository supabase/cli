# Usage-driven test coverage

This document ranks CLI commands, flags, and workflows by real usage from the
`cli_command_executed` telemetry event and compares that ranking with the test suites we run.
It exists so that coverage decisions follow what users, agents, and CI pipelines actually
execute, not what is convenient to test. Numbers are shares and ranks from a four-week window
(2026-08-17 to 2026-09-14); refresh them with the queries in the appendix.

## How runs are classified

Every event carries `is_agent`, `is_ci`, and `is_tty` plus `env_signals`. The analysis uses
four actor classes:

| actor    | rule                                                    |
| -------- | ------------------------------------------------------- |
| agent    | `is_agent = true`                                       |
| ci       | not agent, `is_ci = true`                               |
| human    | not agent, not ci, stdout is a TTY                      |
| headless | not agent, not ci, stdout is not a TTY (scripts, pipes) |

`is_tty` reflects stdout, so a person piping `status -o env` into a shell script counts as
headless. Human numbers are a lower bound.

## What the data says

**Actor mix.** Agents produce about half of all runs, CI a bit more than a third, headless
scripts about one in nine, and interactive humans about one in fifty. Over the last quarter run
volume grew roughly five-fold, almost entirely from agents and CI; the human share fell from
6% to under 2%. Any coverage plan that only models an interactive terminal misses 98% of runs.

**Failure rates by actor.** CI fails least (about 4% of runs). Agents fail about 14% of the
time, humans about 15%, and headless scripts about 31%. High agent failure rates are dominated
by user-actionable errors (wrong flag combinations, unlinked projects, stack not running), which
means error messages and exit codes are part of the contract agents depend on.

**Agent tools.** Two coding agents account for over 90% of agent runs (Claude Code about 64%,
Codex about 30%), followed by Cursor, Antigravity, Hermes, GitHub Copilot CLI, and OpenCode.
CI is 98% GitHub Actions.

**Platforms.** macOS arm64 is the largest platform (about 36% of runs, mostly agents). Linux is
about 45% and almost entirely CI. Windows is about 17% of all runs and about 30% of agent runs,
and Windows has more interactive human runs than macOS. No E2E suite runs on Windows today.

**Emitter.** About 70% of events now come from the TypeScript CLI; the rest still come from
older Go installs. From version 2.114 onward every TypeScript failure carries an
`error_fingerprint`, so failure analysis should filter on recent versions.

### Command ranking

Share of all runs and actor split per command; the last column ranks commands by distinct users.

| rank | command            | runs share | agent | ci  | human | headless | users rank |
| ---- | ------------------ | ---------- | ----- | --- | ----- | -------- | ---------- |
| 1    | status             | 24.7%      | 47%   | 39% | <1%   | 14%      | 1          |
| 2    | db query           | 21.9%      | 76%   | 10% | <1%   | 13%      | 3          |
| 3    | functions deploy   | 9.0%       | 21%   | 71% | 5%    | 3%       | 15         |
| 4    | start              | 6.8%       | 16%   | 60% | 2%    | 22%      | 2          |
| 5    | db reset           | 4.4%       | 51%   | 44% | 2%    | 3%       | 6          |
| 6    | test db            | 4.1%       | 46%   | 51% | <1%   | 2%       | 5          |
| 7    | stop               | 3.8%       | 18%   | 77% | 2%    | 3%       | 4          |
| 8    | db push            | 3.7%       | 54%   | 27% | 11%   | 8%       | 7          |
| 9    | functions serve    | 2.6%       | 54%   | 2%  | <1%   | 43%      | 10         |
| 10   | migration list     | 2.2%       | 68%   | 20% | 5%    | 7%       | 11         |
| 11   | functions download | 1.7%       | 36%   | 58% | <1%   | 5%       | 24         |
| 12   | gen types          | 1.3%       | 51%   | 42% | <1%   | 7%       | 9          |
| 13   | migration up       | 1.3%       | 42%   | 46% | 3%    | 9%       | 8          |
| 14   | link               | 1.3%       | 30%   | 56% | 10%   | 4%       | 18         |
| 15   | projects api-keys  | 1.2%       | 68%   | 2%  | <1%   | 29%      | 27         |
| 16   | db dump            | 1.1%       | 33%   | 41% | 4%    | 22%      | 14         |
| 17   | projects list      | 1.1%       | 82%   | 2%  | 3%    | 13%      | 20         |
| 18   | db lint            | 0.9%       | 46%   | 50% | 1%    | 3%       | 12         |
| 19   | migration repair   | 0.8%       | 26%   | 66% | 5%    | 2%       | 16         |
| 20   | functions list     | 0.8%       | 72%   | 16% | 2%    | 10%      | 28         |
| 21   | db start           | 0.6%       | 8%    | 90% | <1%   | 2%       | 13         |
| 22   | migration new      | 0.5%       | 93%   | 1%  | 4%    | 2%       | 19         |
| 23   | branches get       | 0.5%       | 56%   | 36% | <1%   | 7%       | 32         |
| 24   | branches list      | 0.4%       | 31%   | 61% | <1%   | 8%       | 30         |
| 25   | storage cp         | 0.4%       | 73%   | 9%  | 4%    | 13%      | 35         |
| 26   | secrets set        | 0.4%       | 36%   | 38% | 21%   | 5%       | 26         |
| 27   | secrets list       | 0.4%       | 75%   | 11% | 4%    | 10%      | 29         |
| 28   | init               | 0.3%       | 37%   | 52% | 6%    | 5%       | 17         |
| 29   | db advisors        | 0.3%       | 66%   | 30% | <1%   | 3%       | 22         |
| 30   | login              | 0.2%       | 33%   | 10% | 55%   | 2%       | 21         |

Commands the human (TTY) ranking reorders: functions deploy, db push, start, login, link,
db query, migration list, db reset, secrets set, stop, migration repair, db dump, migration up.
`db pull` is small overall but is 54% human and fails four times out of five (migration
conflicts), and `login` fails about one time in four.

Rarely used commands (fewer than one run in a million): `db branch *`, `issue *`,
`db schema declarative __catalog`, `encryption update-root-key`, `telemetry enable`,
`vanity-subdomains delete`, `branches disable`, `bootstrap`, `backups restore`, `sso remove`,
`postgres-config delete`, `domains delete`. These need a smoke test, not a matrix.

### Flags that matter

Ordered by share of that command's runs. Global flags (`--workdir`, `--debug`, `--profile`,
`--network-id`, `--dns-resolver`) are omitted; `--workdir` is common everywhere.

- `status`: `-o env` (about half of runs, the single most used flag value of the whole CLI),
  `-o json` (about 35%), then `--override-name` together with `-o`.
- `db query`: `--linked` (76%), `--file` (37%), `-o json|csv|table` (24%), `--local` (15%),
  `--output-format` (12%), `--agent` (8%), `--project-ref` (7%, agents), `--db-url` (6%).
  Top combinations: `--linked`; `--file --linked`; `--linked -o json`; `--local`;
  `--file --local` (CI); `--db-url`.
- `functions deploy`: `--project-ref` (82%), `--no-verify-jwt` (33%), `--use-api` (18%),
  `--import-map` (3%, CI), `-o json` (agents), `--jobs`, `--use-docker` (rare).
- `start`: no flags (71%), `--exclude` (23%, mostly CI), `--ignore-health-check` (4%),
  `-o json` (4%, agents), `--yes`, `--network-id`.
- `db reset`: no flags (46%), `--local` (40%), `--no-seed` (19%), `-o json` (10%, agents only),
  `--yes` (7%), `--version` (5%), `--db-url`, `--sql-paths`, `--linked` (human).
- `test db`: no flags (57%), `--local` (36%), `--db-url` (5%), `--linked` (1%).
- `stop`: `--no-backup` (71%), `--project-id` (11%), `-o json` (agents), `--all`.
- `db push`: no flags (20%, human heavy), `--linked` (30%), `--dry-run` (28%), `--yes` (24%),
  `--include-all` (24%), `--db-url` (23%), `-o json` (9%, agents), `--skip-vault`, `--local`,
  `--password`, `--project-ref`, `--include-seed`, `--include-roles`.
- `functions serve`: no flags (56%, almost all agents), `--no-verify-jwt` (33%),
  `--env-file` (26%), `--import-map` (rare).
- `migration list`: `--linked` (48%), no flags (22%), `--local` (14%), `--output-format` (11%),
  `--db-url` (11%), `-o json`, `--password`.
- `functions download`: `--project-ref` (98%), `--use-api` (59%), `--legacy-bundle` (rare).
- `gen types`: `--local` (58%), `--schema` (47%), `--project-id` (18%), `--db-url` (13%),
  `--linked` (10%), `--lang` (6%: typescript, then python, swift, go).
- `migration up`: `--local` (67%), `--include-all` (33%), `--db-url` (19%), `--yes` (19%),
  `--linked` (1%).
- `link`: `--project-ref` (99%), `--password` (12%), `--yes` (10%), interactive with no flags
  (human), `--skip-pooler`.
- `projects api-keys`: `--project-ref`, `-o json` (66%), `--reveal` (19%), `-o env`.
- `db dump`: `--file` (81%), `--db-url` (51%), `--schema` (45%), `--linked` (32%),
  `--data-only` (31%), `--use-copy` (22%), `--role-only` (14%), `--dry-run` (14%, agents),
  `--exclude`, `--local`, `--keep-comments`.
- `db lint`: `--level` (69%: warning, error), `--local` (60%), `--fail-on` (45%: error, warning,
  none), `--schema` (31%), `--linked`, `--db-url`.
- `migration repair`: `--status` (100%: applied 80%, reverted 20%), `--local` (29%),
  `--linked` (14%), `--db-url` (13%), `--yes`.
- `db advisors`: `--type` (security, all, performance), `--level` (warn, info, error),
  `--fail-on` (error, none, warn), `--local`, `--linked`.
- `login`: no flags (65%, human), `--token` (20%), `--no-browser` (10%), `--name` (9%),
  `--agent` (7%).
- `init`: no flags (58%), `--force` (24%), `--yes` (18%), editor settings flags (rare).
- `db diff`: `--schema` (53%), `--local` (26%), `--file` (20%), `--linked` (19%), no flags,
  `--db-url`, `--use-pg-delta`, `--use-migra`, `--use-pg-schema` (deprecated Go path).

Output format: agents request JSON almost universally (`db query`, `db push`, `db reset`,
`test db`, `start`, `migration list`, `projects *`, `functions *`). CI mostly runs in text mode,
except `status -o env`. `stream-json` appears in tiny numbers on about fifteen commands.

### Workflows

Command sets observed inside one CLI session (same `$session_id`), most frequent first.

CI pipelines: `start > status`, `start > status > stop`, `start > stop`,
`db reset > start > status > stop`, `start > test db`, `db start > test db`,
`link > db push`, `link > db push > migration list`, `link > db push > functions deploy`,
`start > gen types`, `db lint > db reset > start`, `init > start > status > stop`,
`services > stop`.

Agents: `migration list > db push`, `db reset > test db`, `db reset > status`,
`db push > db query`, `projects list > db query`, `functions list > functions deploy`,
`link > db query`, `functions deploy > db query`, `migration list > db query`,
`projects api-keys > db query`, `storage cp > db query`, `db push > gen types`,
`db reset > gen types`, `migration up > status`, `migration repair > db query`,
`secrets set > functions deploy`.

### Failure paths that dominate

On current TypeScript releases, failures are overwhelmingly `user_actionable`. The most frequent
fingerprints, which tests should pin (message, exit code, and classification):

- `status`: `LegacyStatusDbInspectError` (stack not running; the top classified failure of the
  CLI, mostly agents), `LegacyStatusConfigLoadError`, `LegacyStatusDbNotRunningError`.
- `db query`: `LegacyDbQueryUnexpectedStatusError:query` (SQL error), `LegacyDbQueryExecError`,
  `LegacyProjectNotLinkedError`, `LegacyDbQueryMutuallyExclusiveFlagsError` (agents),
  `LegacyPlatformAuthRequiredError`, `LegacyDbQueryReadFileError`,
  `LegacyDbConfigConnectTempRoleError`, `LegacyDbConnectError`.
- `test db`: `LegacyTestDbRunError` (failing pgTAP tests; expected), `LegacyDbConnectError`.
- `db push`: `LegacyDbPushApplyError`, `LegacyDbPushMissingLocalError`,
  `LegacyDbPushMissingRemoteError`, `LegacyDbConnectError`, `LegacyProjectNotLinkedError`.
- `start`: `LegacyMigrationApplyError` (CI, long duration), `docker_not_running`,
  `LegacyHealthCheckTimeoutError`, `port_conflict`, `container_configuration`,
  `LegacyImagePrepullError:registry_pull`.
- `migration up`, `db reset`, `db start`: `LegacyMigrationApplyError`, `LegacyDbSetupError`,
  `LegacyResetLocalDbNotRunningError`, `LegacyMigrationSeedError`.
- `login`: `LegacyLoginMissingTokenError` and `NonInteractiveError` (agents), `Interrupt` (humans).
- `functions deploy`: `FunctionsApiStatusError:api_status|auth|forbidden`, `AggregateError`
  (internal bug, long duration).
- `branches get`: `not_found` (agents polling; nearly half of runs fail).
- `db pull`: `LegacyDbPullMigrationConflictError` (human).
- `db diff`: `LegacyShadowDbError:port_conflict` (agents).

Two telemetry gaps need fixing before failure rates can be trusted as a regression signal:

- `functions serve` on current versions reports about three quarters of runs as `error:unknown`
  with a sub-second duration in non-TTY mode. This is not a killed long-running server; the
  process exits almost immediately with an unclassified error.
- `gen types`, `functions deploy`, and `functions download` also emit a meaningful slice of
  `error:unknown` fast failures.

## Coverage today

Suites and where they run:

| suite                               | shape                                             | cases           | when                                         |
| ----------------------------------- | ------------------------------------------------- | --------------- | -------------------------------------------- |
| `apps/cli/**/*.unit.test.ts`        | pure logic                                        | large           | every PR                                     |
| `apps/cli/**/*.integration.test.ts` | handlers with realistic Effect layers             | ~3.7k           | every PR                                     |
| `apps/cli/**/*.e2e.test.ts`         | compiled binary via `runSupabase`, local Docker   | 94 in 48 files  | every PR, 3 shards, Linux only               |
| `apps/cli-e2e/**/*.e2e.test.ts`     | subprocess against a record/replay Management API | 432 in 21 files | every PR, Linux only                         |
| `apps/cli/**/*.live.test.ts`        | provisioned staging project                       | 48              | nightly, develop pushes, stable release gate |
| `cli-e2e-ci` (external)             | full stack from the PR head                       |                 | opt-in label                                 |

Nothing exercises the CLI binary on Windows or macOS apart from release smoke tests.

### Top 20 commands against E2E depth

Counts are E2E cases in `apps/cli` and `apps/cli-e2e` that target the command (approximate).
"Missing" lists the high-share flags or paths with no subprocess coverage.

| command            | cli e2e | cli-e2e     | missing                                                                        |
| ------------------ | ------- | ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------ |
| status             | 8       | 1           | `-o env` shape, `--override-name`, not-running exit code and message           |
| db query           | 0       | 4           | `--local`, `--file`, `-o json                                                  | csv                                              | table`, `--db-url`, mutual-exclusion |
| functions deploy   | 4       | 4           | `--no-verify-jwt`, `--import-map`, `-o json`, multi-function deploy            |
| start              | 22      | 0 (+2 todo) | `-o json`, migration-apply failure path                                        |
| db reset           | 2       | 1           | `--no-seed`, `--version`, `-o json`, `--linked`, `--db-url`                    |
| test db            | 0       | 1           | `--local` pass and fail exit codes, `--db-url`                                 |
| stop               | 10      | 2           | `--all` happy path, `-o json`                                                  |
| db push            | 2       | 3           | `--dry-run`, `--include-all`, `--yes`, `--password`, `-o json`, drift          |
| functions serve    | 0       | 0           | lifecycle (start, ready, SIGINT exit 0), `--env-file`, `--no-verify-jwt`       |
| migration list     | 0       | 1           | `--linked`, `--local`, `--db-url`, `-o json`                                   |
| functions download | 1       | 5           | adequate                                                                       |
| gen types          | 1       | 6           | `--lang` matrix, `--schema` lists, `--local` against a running stack           |
| migration up       | 0       | 1           | `--local`, `--include-all`, `--db-url`, `--yes`                                |
| link               | 1       | 7           | interactive selection with no `--project-ref`                                  |
| projects api-keys  | 0       | 5           | `-o env`, `--reveal`                                                           |
| db dump            | 0       | 2           | `--db-url --file --role-only`, `--data-only --use-copy`, `--schema`, `--local` |
| projects list      | 0       | 7           | adequate                                                                       |
| db lint            | 0       | 1           | `--level` and `--fail-on` exit codes, `--local`, `--schema`                    |
| migration repair   | 0       | 2           | `--status applied                                                              | reverted`across`--local`, `--linked`, `--db-url` |
| functions list     | 0       | 7           | adequate                                                                       |

Outside the top 20: `login` has two live E2E cases and the cli-e2e `auth` suite is a `todo`,
although it is the fourth most used human command and fails one time in four. `db pull` has one
case per suite and fails four times in five. `inspect db *` has no subprocess coverage.

## Plan

Priority is share of runs times distinct users, split by actor so each class gets its own
invocation shape (agents: JSON output and structured errors; CI: non-TTY, `--yes`, `-o env`;
humans: prompts and text errors).

### Phase 1: local-stack golden paths in `apps/cli` E2E

One test file per command, one to three cases each, all against the Docker stack the suite
already starts:

1. `db query`: `--local` with inline SQL, `--file`, `-o json`, `-o csv`, `-o table`, and the
   `--local --linked` mutual-exclusion error.
2. `test db --local`: passing suite exits 0, failing pgTAP test exits 1 with the
   `LegacyTestDbRunError` message.
3. `db reset`: `--local --no-seed`, `--version`, `-o json` (agents), then `status -o env`
   and `-o json` shape and `--override-name`.
4. `start --exclude ... -o json` and `stop --no-backup --project-id`, plus `stop --all`.
5. `db push --local --dry-run`, `--local --include-all --yes`, and the missing-local drift error.
6. `migration up --local --include-all`, `migration list --local -o json`,
   `migration repair --local --status applied|reverted`.
7. `db dump --local --file`, `--role-only`, `--data-only --use-copy`, `--schema`.
8. `db lint --local --level warning --fail-on error` exit codes.
9. `functions serve` lifecycle: starts, answers a request, exits 0 on SIGINT; `--env-file` and
   `--no-verify-jwt` variants. Root-cause the `error:unknown` fast failure first.

### Phase 2: platform paths in `apps/cli-e2e`

Record scenarios for the linked and `--project-ref` shapes agents and CI use:

1. `db push --linked --dry-run`, `--linked --include-all --yes`, `-o json`.
2. `migration list|up|repair --linked` and `--db-url`.
3. `functions deploy --project-ref --use-api` with `--no-verify-jwt`, `--import-map`, `--jobs`,
   several functions, and `-o json`; the `api_status`, `auth`, and `forbidden` failure shapes.
4. `db query --linked --file -o json` and the `--project-ref` form.
5. `projects api-keys -o env` and `--reveal`.
6. `login --token`, `--no-browser`, `--name`, `--agent` (replace the `auth` todo);
   `NonInteractiveError` and missing-token paths.
7. Turn the `start` todos into a recorded `start > status > stop` lifecycle.

### Phase 3: actor-mode matrices

1. Agent mode: for the top ten agent commands, run with `CLAUDECODE=1` (or `--agent yes`) and
   assert JSON on stdout, structured errors, and exit codes for the top fingerprints.
2. CI mode: for the top ten CI commands, run with `CI=1 GITHUB_ACTIONS=1`, no TTY, and assert
   there are no prompts and `--yes` semantics hold.
3. Windows: run the non-Docker subset of `apps/cli` E2E and all of `apps/cli-e2e` on
   `windows-latest`. Windows is about 17% of runs and nothing subprocess-level covers it.

### Phase 4: workflow scenarios

Three or four session-level E2E scenarios mirroring the observed sets:

- CI: `init > start --exclude > db reset --no-seed > test db > gen types --local > stop --no-backup`.
- CI platform: `link --project-ref > db push --dry-run > db push --include-all --yes > migration list > functions deploy --use-api`.
- Agent: `projects list -o json > link > migration list -o json > db push --dry-run -o json > db query --linked -o json`.
- Human: `login --token > link > db pull > db push > functions deploy` in text mode.

### Phase 5: failure-path contract

For each fingerprint in the failure list above, one test pins the message, exit code, and
`error_kind`, using the existing failure-metadata E2E harness. Fix the `error:unknown`
classification gaps so failure rate per command becomes a usable regression signal.

### Keeping the ranking current

Re-run the appendix queries quarterly, or when a command family changes, and update the tables.
Tests added for a command that later falls below one run in a million can be reduced to a smoke
case.

## Appendix: queries

HogQL against the PostHog `events` table. Replace the window as needed.

Actor split:

```sql
SELECT
  multiIf(properties.is_agent = true, 'agent',
          properties.is_ci = true, 'ci',
          properties.is_tty = true, 'human_tty', 'headless_other') AS actor,
  count() AS runs,
  uniq(person_id) AS users,
  round(countIf(properties.exit_code != 0) / count(), 4) AS failure_rate
FROM events
WHERE event = 'cli_command_executed'
  AND timestamp >= toDateTime('2026-08-17 00:00:00')
  AND timestamp < toDateTime('2026-09-14 00:00:00')
GROUP BY actor
ORDER BY runs DESC
```

Commands with actor split:

```sql
SELECT
  properties.command AS command,
  count() AS runs,
  uniq(person_id) AS users,
  countIf(properties.is_agent = true) AS agent_runs,
  countIf(properties.is_agent != true AND properties.is_ci = true) AS ci_runs,
  countIf(properties.is_agent != true AND properties.is_ci != true AND properties.is_tty = true) AS human_runs,
  countIf(properties.is_agent != true AND properties.is_ci != true AND properties.is_tty != true) AS headless_runs,
  round(countIf(properties.exit_code != 0) / count(), 4) AS failure_rate
FROM events
WHERE event = 'cli_command_executed'
  AND timestamp >= toDateTime('2026-08-17 00:00:00')
  AND timestamp < toDateTime('2026-09-14 00:00:00')
GROUP BY command
ORDER BY runs DESC
LIMIT 200
```

Flags per command (the `flags` property is a JSON object of flag name to safe value):

```sql
SELECT command, flag, runs, users
FROM (
  SELECT
    properties.command AS command,
    arrayJoin(JSONExtractKeys(ifNull(toString(properties.flags), '{}'))) AS flag,
    count() AS runs,
    uniq(person_id) AS users
  FROM events
  WHERE event = 'cli_command_executed'
    AND timestamp >= toDateTime('2026-08-17 00:00:00')
    AND timestamp < toDateTime('2026-09-14 00:00:00')
  GROUP BY command, flag
)
WHERE runs >= 200
ORDER BY runs DESC
LIMIT 500
```

Flag combinations per command (global flags stripped):

```sql
SELECT
  properties.command AS command,
  arrayStringConcat(arraySort(arrayFilter(
    k -> k NOT IN ('workdir', 'debug', 'log-level', 'profile', 'network-id', 'dns-resolver'),
    JSONExtractKeys(ifNull(toString(properties.flags), '{}')))), ' ') AS combo,
  count() AS runs
FROM events
WHERE event = 'cli_command_executed'
  AND timestamp >= toDateTime('2026-08-17 00:00:00')
  AND timestamp < toDateTime('2026-09-14 00:00:00')
  AND properties.command IN ('db query', 'db push')
GROUP BY command, combo
ORDER BY command, runs DESC
LIMIT 500
```

Agent tool from `env_signals`:

```sql
SELECT
  multiIf(
    JSONHas(toString(properties.env_signals), 'CLAUDECODE'), 'claude-code',
    JSONHas(toString(properties.env_signals), 'CURSOR_AGENT'), 'cursor',
    JSONHas(toString(properties.env_signals), 'CODEX_THREAD_ID')
      OR JSONHas(toString(properties.env_signals), 'CODEX_SANDBOX'), 'codex',
    JSONHas(toString(properties.env_signals), 'GEMINI_CLI'), 'gemini',
    JSONHas(toString(properties.env_signals), 'AI_AGENT'),
      concat('ai_agent:', splitByChar('_', JSONExtractString(toString(properties.env_signals), 'AI_AGENT'))[1]),
    'unknown') AS agent_tool,
  count() AS runs,
  uniq(person_id) AS users
FROM events
WHERE event = 'cli_command_executed'
  AND timestamp >= toDateTime('2026-08-17 00:00:00')
  AND timestamp < toDateTime('2026-09-14 00:00:00')
  AND properties.is_agent = true
GROUP BY agent_tool
ORDER BY runs DESC
```

Failure fingerprints per command:

```sql
SELECT
  properties.command AS command,
  properties.error_fingerprint AS fingerprint,
  properties.error_kind AS kind,
  count() AS runs,
  uniq(person_id) AS users
FROM events
WHERE event = 'cli_command_executed'
  AND timestamp >= toDateTime('2026-08-17 00:00:00')
  AND timestamp < toDateTime('2026-09-14 00:00:00')
  AND properties.exit_code != 0
  AND properties.$lib = 'posthog-node'
GROUP BY command, fingerprint, kind
ORDER BY runs DESC
LIMIT 150
```

Command sets per session:

```sql
SELECT arrayStringConcat(cmds, ' | ') AS command_set, count() AS sessions
FROM (
  SELECT
    properties.$session_id AS sid,
    arraySort(groupUniqArray(properties.command)) AS cmds
  FROM events
  WHERE event = 'cli_command_executed'
    AND timestamp >= toDateTime('2026-09-07 00:00:00')
    AND timestamp < toDateTime('2026-09-14 00:00:00')
    AND properties.$session_id IS NOT NULL
  GROUP BY sid
  HAVING length(cmds) BETWEEN 2 AND 6
)
GROUP BY command_set
ORDER BY sessions DESC
LIMIT 80
```
