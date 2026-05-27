# Go CLI Porting Status

Manual parity tracker for the TypeScript CLI port. Update this file whenever a command is added or parity changes.

Reference:

- Old Go CLI help dump: [`go-cli-reference.md`](./go-cli-reference.md)
- Current TS root command: [`../src/next/cli/root.ts`](../src/next/cli/root.ts)

## Legend

- `ported`: TS command exists and the flag/parameter surface is materially aligned with the old Go CLI
- `partial`: TS feature exists but differs materially from the old Go CLI shape, flag surface, or invocation style. This includes feature parity delivered through framework-built global flags such as `--help` instead of matching Go subcommands exactly.
- `missing`: no TS command/subcommand exists yet

Percentages and counts below are based on final leaf commands only. Command groups like `db`, `functions`, and `completion` are not counted as commands.

## Summary

| Metric                    |   Count | Percent |
| ------------------------- | ------: | ------: |
| Fully ported commands     |  6 / 94 |    6.4% |
| Partially ported commands | 55 / 94 |   58.5% |

## Family Summary

| Family                    | Final commands |  `ported` | `partial` | `missing` | Represented in TS |
| ------------------------- | -------------: | --------: | --------: | --------: | ----------------: |
| Quick Start               |              1 |    0 (0%) |    0 (0%) |  1 (100%) |            0 (0%) |
| Project / Stack Lifecycle |              9 | 2 (22.2%) | 7 (77.8%) |    0 (0%) |          9 (100%) |
| Database                  |             19 |    0 (0%) |    0 (0%) | 19 (100%) |            0 (0%) |
| Code Generation           |              3 |    0 (0%) |    0 (0%) |  3 (100%) |            0 (0%) |
| Functions                 |              6 |    0 (0%) |    0 (0%) |  6 (100%) |            0 (0%) |
| Storage                   |              4 |    0 (0%) |    0 (0%) |  4 (100%) |            0 (0%) |
| Management APIs           |             47 |    0 (0%) | 47 (100%) |    0 (0%) |         47 (100%) |
| Additional Commands       |              5 |   4 (80%) |   1 (20%) |    0 (0%) |        5 (100.0%) |

## Global Flags Overview

This tracker is command-focused, but root global flag drift is large enough to note separately.

| Surface                 | TS path                                                                  | Missing old flags/params                                                                                                        | Extra TS flags/params | Notes                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase` global flags | [`../src/shared/cli/global-flags.ts`](../src/shared/cli/global-flags.ts) | `--create-ticket`, `--debug`, `--dns-resolver`, `--experimental`, `--network-id`, `--output`, `--profile`, `--workdir`, `--yes` | `--output-format`     | Root flag parity is still far from the Go CLI, but the framework already provides global `--help`, and `supabase completion <shell>` is restored as a Go-style subcommand. The framework's `--completions` global flag remains available for `next/` users. |

## TS-only Commands

These commands exist in the TS CLI today but have no direct top-level equivalent in the old Go CLI reference.

| TS command        | TS path                                                                                                            | Notes                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`             | `planned`                                                                                                          | Reserved for a TS-native long-running local development workflow command that watches files and orchestrates subcommands. Track this as TS-only unless a direct Go equivalent emerges.        |
| `logs`            | [`../src/next/commands/logs/logs.command.ts`](../src/next/commands/logs/logs.command.ts)                           | Streams local stack logs. No top-level `logs` command exists in the old Go CLI reference.                                                                                                     |
| `api`             | [`../src/next/commands/platform/api.command.ts`](../src/next/commands/platform/api.command.ts)                     | Low-level Management API client. It supersedes the old generated tree with explicit discovery via `supabase api routes` and execution via `supabase api request <route> [--method <METHOD>]`. |
| `stack`           | [`../src/next/cli/root.ts`](../src/next/cli/root.ts)                                                               | TS-only local runtime namespace exposing `stack start`, `stack stop`, `stack status`, `stack list`, and `stack update`. Top-level `start`, `stop`, and `status` remain aliases.               |
| `branches switch` | [`../src/next/commands/branches/switch/switch.command.ts`](../src/next/commands/branches/switch/switch.command.ts) | No direct Go equivalent. Updates local active-branch state so subsequent commands target the selected branch.                                                                                 |

## Quick Start

| Old command | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                                       |
| ----------- | --------- | ---------------------------- | -------------------- | --------------------- | ------------------------------------------- |
| `bootstrap` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS command yet. Wrapped in legacy shell. |

## Project / Stack Lifecycle

| Old command | TS status | TS command path or `missing`                                                                     | Missing flags/params                                                                                                                                                              | Extra TS flags/params                      | Notes                                                                                                                                                                                                                                                                                         |
| ----------- | --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`      | `partial` | [`../src/next/commands/init/init.command.ts`](../src/next/commands/init/init.command.ts)         | `--force`, `--interactive`, `--use-orioledb`                                                                                                                                      | `-`                                        | TS init creates a minimal `supabase/config.json` with only a `"$schema"` reference and ensures repo-local `.supabase/` state can stay gitignored, but it does not yet expose the old Go flag surface.                                                                                         |
| `link`      | `partial` | [`../src/next/commands/link/link.command.ts`](../src/next/commands/link/link.command.ts)         | `--password`, `--skip-pooler`                                                                                                                                                     | `-`                                        | TS link supports `--project-ref`, interactive project selection, and zero-config linking. It stores linked remote metadata in repo-local `.supabase/project.json`, but it does not yet manage direct database-password or pooler-specific link flows.                                         |
| `unlink`    | `ported`  | [`../src/next/commands/unlink/unlink.command.ts`](../src/next/commands/unlink/unlink.command.ts) | `-`                                                                                                                                                                               | `-`                                        | TS unlink matches the current Go surface and removes the repo-local linked project metadata for the active checkout.                                                                                                                                                                          |
| `login`     | `ported`  | [`../src/next/commands/login/login.command.ts`](../src/next/commands/login/login.command.ts)     | `-`                                                                                                                                                                               | `-`                                        | Flag surface matches the old CLI: `--token`, `--name`, `--no-browser`. TS also supports env-var and piped-stdin token input without adding new flags.                                                                                                                                         |
| `logout`    | `partial` | [`../src/next/commands/logout/logout.command.ts`](../src/next/commands/logout/logout.command.ts) | `-`                                                                                                                                                                               | `--yes`                                    | TS adds `--yes` to skip the confirmation prompt in non-interactive / scripted contexts. No equivalent flag in the Go CLI, so this remains partial rather than fully ported.                                                                                                                   |
| `start`     | `partial` | [`../src/next/commands/start/start.command.ts`](../src/next/commands/start/start.command.ts)     | `--ignore-health-check`, `--sandbox`; legacy `--exclude` names like `gotrue`, `storage-api`, `postgres-meta`, `edge-runtime`, `logflare`, `supavisor`, and `kong` are not aligned | `--stack`, `--service-version`, `--detach` | TS start supports foreground and detached modes, named managed stacks, pinned stack baselines, linked/local/per-run service version overrides, and exclusions for `auth`, `postgrest`, `realtime`, `storage`, `imgproxy`, `mailpit`, `pgmeta`, `studio`, `analytics`, `vector`, and `pooler`. |
| `stop`      | `partial` | [`../src/next/commands/stop/stop.command.ts`](../src/next/commands/stop/stop.command.ts)         | `--all`, `--project-id`                                                                                                                                                           | `--stack`                                  | Current TS stop only covers one project-scoped managed stack at a time. It supports `--no-backup`, can target non-default stack names with `--stack`, and preserves pinned stack metadata unless `--no-backup` is used.                                                                       |
| `status`    | `partial` | [`../src/next/commands/status/status.command.ts`](../src/next/commands/status/status.command.ts) | `--override-name`                                                                                                                                                                 | `--stack`                                  | Current TS status shows a detailed running or stopped view for one project-scoped managed stack and reports whether pinned stack versions are up to date against the cached linked/default baseline.                                                                                          |

<!-- Note: start, stop, and status are also wrapped in the legacy shell — see Legacy Shell Wrapping Status below. -->

| `services` | `partial` | `supabase status` + `supabase stack update` | Go-style dedicated `services` command shape | `--stack` | The old version-reporting and linked-version drift behavior exists in TS, but it is split across `status` for per-service versions and `stack update` for refreshing pinned versions instead of a single `services` command. |

## Database

| Old command                       | TS status | TS command path or `missing`                       | Missing flags/params | Extra TS flags/params | Notes                                                                 |
| --------------------------------- | --------- | -------------------------------------------------- | -------------------- | --------------------- | --------------------------------------------------------------------- |
| `db diff`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db dump`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db lint`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db pull`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db push`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db reset`                        | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `db start`                        | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `inspect report`                  | `wrapped` | `legacy/commands/inspect/report/`                  | `n/a`                | `n/a`                 | Phase 0 proxy. Wrapped in legacy shell.                               |
| `inspect db db-stats`             | `wrapped` | `legacy/commands/inspect/db/db-stats/`             | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db replication-slots`    | `wrapped` | `legacy/commands/inspect/db/replication-slots/`    | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db locks`                | `wrapped` | `legacy/commands/inspect/db/locks/`                | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db blocking`             | `wrapped` | `legacy/commands/inspect/db/blocking/`             | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db outliers`             | `wrapped` | `legacy/commands/inspect/db/outliers/`             | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db calls`                | `wrapped` | `legacy/commands/inspect/db/calls/`                | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db index-stats`          | `wrapped` | `legacy/commands/inspect/db/index-stats/`          | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db long-running-queries` | `wrapped` | `legacy/commands/inspect/db/long-running-queries/` | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db bloat`                | `wrapped` | `legacy/commands/inspect/db/bloat/`                | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db role-stats`           | `wrapped` | `legacy/commands/inspect/db/role-stats/`           | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db vacuum-stats`         | `wrapped` | `legacy/commands/inspect/db/vacuum-stats/`         | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db table-stats`          | `wrapped` | `legacy/commands/inspect/db/table-stats/`          | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db traffic-profile`      | `wrapped` | `legacy/commands/inspect/db/traffic-profile/`      | `n/a`                | `n/a`                 | Phase 0 proxy. Queries Postgres directly. Wrapped in legacy shell.    |
| `inspect db cache-hit`            | `wrapped` | `legacy/commands/inspect/db/cache-hit/`            | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use db-stats). Wrapped in legacy shell.    |
| `inspect db index-usage`          | `wrapped` | `legacy/commands/inspect/db/index-usage/`          | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use index-stats). Wrapped in legacy shell. |
| `inspect db total-index-size`     | `wrapped` | `legacy/commands/inspect/db/total-index-size/`     | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use index-stats). Wrapped in legacy shell. |
| `inspect db index-sizes`          | `wrapped` | `legacy/commands/inspect/db/index-sizes/`          | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use index-stats). Wrapped in legacy shell. |
| `inspect db table-sizes`          | `wrapped` | `legacy/commands/inspect/db/table-sizes/`          | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use table-stats). Wrapped in legacy shell. |
| `inspect db table-index-sizes`    | `wrapped` | `legacy/commands/inspect/db/table-index-sizes/`    | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use table-stats). Wrapped in legacy shell. |
| `inspect db total-table-sizes`    | `wrapped` | `legacy/commands/inspect/db/total-table-sizes/`    | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use table-stats). Wrapped in legacy shell. |
| `inspect db unused-indexes`       | `wrapped` | `legacy/commands/inspect/db/unused-indexes/`       | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use index-stats). Wrapped in legacy shell. |
| `inspect db table-record-counts`  | `wrapped` | `legacy/commands/inspect/db/table-record-counts/`  | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use table-stats). Wrapped in legacy shell. |
| `inspect db seq-scans`            | `wrapped` | `legacy/commands/inspect/db/seq-scans/`            | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use index-stats). Wrapped in legacy shell. |
| `inspect db role-configs`         | `wrapped` | `legacy/commands/inspect/db/role-configs/`         | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use role-stats). Wrapped in legacy shell.  |
| `inspect db role-connections`     | `wrapped` | `legacy/commands/inspect/db/role-connections/`     | `n/a`                | `n/a`                 | Phase 0 proxy. Deprecated (use role-stats). Wrapped in legacy shell.  |
| `migration down`                  | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration fetch`                 | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration list`                  | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration new`                   | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration repair`                | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration squash`                | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `migration up`                    | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `seed buckets`                    | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `test db`                         | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |
| `test new`                        | `missing` | `missing`                                          | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell.             |

## Code Generation

| Old command       | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                                                     |
| ----------------- | --------- | ---------------------------- | -------------------- | --------------------- | --------------------------------------------------------- |
| `gen bearer-jwt`  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell. |
| `gen signing-key` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell. |
| `gen types`       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No native TS implementation yet. Wrapped in legacy shell. |

## Functions

The old Go `functions` family mixed linked-project operations (`list`, `deploy`, `download`, `delete`) with local-development workflows (`new`, `serve`).

Current TS only exposes low-level Management API routes under [`api`](../src/next/commands/platform/api.command.ts). This tracker does not count those routes as parity for the old `functions` command family, because there is still no dedicated TS `functions` CLI surface and no local Functions workflow equivalent.

| Old command          | TS status | New TS counterpart(s) | Notes                                                                                                                                                            |
| -------------------- | --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions delete`   | `missing` | `missing`             | Remote Management API routes exist under `supabase api request ...`, but there is no dedicated TS `functions delete` command surface. Wrapped in legacy shell.   |
| `functions deploy`   | `missing` | `missing`             | Remote Management API routes exist under `supabase api request ...`, but there is no dedicated TS `functions deploy` command surface. Wrapped in legacy shell.   |
| `functions download` | `missing` | `missing`             | Remote Management API routes exist under `supabase api request ...`, but there is no dedicated TS `functions download` command surface. Wrapped in legacy shell. |
| `functions list`     | `missing` | `missing`             | Remote Management API routes exist under `supabase api request ...`, but there is no dedicated TS `functions list` command surface. Wrapped in legacy shell.     |
| `functions new`      | `missing` | `missing`             | No TS local scaffold command yet. Wrapped in legacy shell.                                                                                                       |
| `functions serve`    | `missing` | `missing`             | No TS local Functions serving command yet. Wrapped in legacy shell.                                                                                              |

## Storage

The old Go `storage` family could target either the linked project or the local Storage API via `--linked` / `--local`.

Current TS only exposes low-level Management API routes under [`api`](../src/next/commands/platform/api.command.ts). This tracker does not count those routes as parity for the old `storage` object-management CLI surface, especially because there is no TS equivalent for the old local Storage API workflow.

| Old command  | TS status | New TS counterpart(s) | Notes                                                                                                                                                                                                      |
| ------------ | --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage cp` | `missing` | `missing`             | No TS object copy command in `next/`. Legacy shell proxy exposes `--recursive`, `--local`, `--linked`, `--cache-control`, `--content-type`, `--copy-metadata` matching the Go CLI flag surface.            |
| `storage ls` | `missing` | `missing`             | No TS object listing command in `next/`. Legacy shell proxy exposes `--recursive`, `--local`, `--linked` matching the Go CLI flag surface.                                                                 |
| `storage mv` | `missing` | `missing`             | No TS object move command in `next/`. Legacy shell proxy exposes `--recursive`, `--local`, `--linked` matching the Go CLI flag surface.                                                                    |
| `storage rm` | `missing` | `missing`             | No TS object remove command in `next/`. Legacy shell proxy exposes `--recursive`, `--local`, `--linked` matching the Go CLI flag surface. Pass global `--yes` to skip the interactive confirmation prompt. |

## Management APIs

The remaining old Go Management API surface has been replaced by the route-first [`api`](../src/next/commands/platform/api.command.ts) command.

That means parity is no longer 1:1 at the flag level, but capability coverage is broader than the old Go surface:

- every current Management API OpenAPI route is exposed through `supabase api request <route> [--method <METHOD>]`
- the metadata test in [`../src/next/commands/platform/platform-metadata.unit.test.ts`](../src/next/commands/platform/platform-metadata.unit.test.ts) verifies that every exported SDK/OpenAPI operation is represented exactly once
- because the public UX is intentionally different, these commands are tracked as `partial` rather than `ported`

Common input drift across all Management API mappings:

- missing old command-specific flags/parameters:
  the old hand-written subcommand flags are generally replaced by the generic route-first input model
- extra TS flags/parameters:
  `--method`, `--params`, `--json`, `--body`, `--body-file`, `--upload`, `--fields`, `--schema`, `--dry-run`, `--yes`

Representative mappings:

- `projects list` -> `supabase api request /v1/projects`
- `projects create` -> `supabase api request /v1/projects --method POST`
- `projects get` -> `supabase api request /v1/projects/{ref}`
- `projects config auth get` -> `supabase api request /v1/projects/{ref}/config/auth`
- `projects config auth update` -> `supabase api request /v1/projects/{ref}/config/auth --method PATCH`
- `branches get` -> `supabase api request /v1/projects/{ref}/branches/{branch_id}`
- `sso list` -> `supabase api request /v1/projects/{ref}/config/auth/sso/providers`

These route-first equivalents are intentionally lower-level than the old Go command families. Hand-written UX such as `supabase branches create` and `supabase branches list` still exists separately where the CLI benefits from a dedicated workflow.

## Additional Commands

| Old command             | TS status | TS command path or `missing`     | Missing flags/params                    | Extra TS flags/params | Notes                                                                                                        |
| ----------------------- | --------- | -------------------------------- | --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `completion bash`       | `ported`  | `supabase completion bash`       | `-`                                     | `-`                   | Proxies verbatim to the Go binary so the emitted script is byte-identical to Cobra's output (CLI-1532).      |
| `completion fish`       | `ported`  | `supabase completion fish`       | `-`                                     | `-`                   | Proxies verbatim to the Go binary so the emitted script is byte-identical to Cobra's output (CLI-1532).      |
| `completion powershell` | `ported`  | `supabase completion powershell` | `-`                                     | `-`                   | Proxies verbatim to the Go binary so the emitted script is byte-identical to Cobra's output (CLI-1532).      |
| `completion zsh`        | `ported`  | `supabase completion zsh`        | `-`                                     | `-`                   | Proxies verbatim to the Go binary so the emitted script is byte-identical to Cobra's output (CLI-1532).      |
| `help`                  | `partial` | `supabase --help`                | Go-style top-level `help` command shape | `-`                   | Feature parity exists via the framework-provided global `--help` flag instead of a dedicated `help` command. |

## Legacy Shell Wrapping Status

Phase 0 proxy wrappers in the legacy shell (`src/legacy/`). Each wrapped command forwards to the bundled Go binary via `LegacyGoProxy`.
The `migration` command group also accepts Go's top-level `migrations` alias and forwards singular `migration` argv to Go.

Legend:

- `wrapped`: Phase 0 proxy wrapper exists in the legacy shell
- `missing`: no legacy shell command yet

| Command                                | Legacy status | Legacy command path                                                                                                                                                                       |
| -------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgs list`                            | `wrapped`     | [`../src/legacy/commands/orgs/list/list.command.ts`](../src/legacy/commands/orgs/list/list.command.ts)                                                                                    |
| `orgs create`                          | `wrapped`     | [`../src/legacy/commands/orgs/create/create.command.ts`](../src/legacy/commands/orgs/create/create.command.ts)                                                                            |
| `projects list`                        | `wrapped`     | [`../src/legacy/commands/projects/list/list.command.ts`](../src/legacy/commands/projects/list/list.command.ts)                                                                            |
| `projects create`                      | `wrapped`     | [`../src/legacy/commands/projects/create/create.command.ts`](../src/legacy/commands/projects/create/create.command.ts)                                                                    |
| `projects delete`                      | `wrapped`     | [`../src/legacy/commands/projects/delete/delete.command.ts`](../src/legacy/commands/projects/delete/delete.command.ts)                                                                    |
| `projects api-keys`                    | `wrapped`     | [`../src/legacy/commands/projects/api-keys/api-keys.command.ts`](../src/legacy/commands/projects/api-keys/api-keys.command.ts)                                                            |
| `branches list`                        | `wrapped`     | [`../src/legacy/commands/branches/list/list.command.ts`](../src/legacy/commands/branches/list/list.command.ts)                                                                            |
| `branches create`                      | `wrapped`     | [`../src/legacy/commands/branches/create/create.command.ts`](../src/legacy/commands/branches/create/create.command.ts)                                                                    |
| `branches get`                         | `wrapped`     | [`../src/legacy/commands/branches/get/get.command.ts`](../src/legacy/commands/branches/get/get.command.ts)                                                                                |
| `branches update`                      | `wrapped`     | [`../src/legacy/commands/branches/update/update.command.ts`](../src/legacy/commands/branches/update/update.command.ts)                                                                    |
| `branches pause`                       | `wrapped`     | [`../src/legacy/commands/branches/pause/pause.command.ts`](../src/legacy/commands/branches/pause/pause.command.ts)                                                                        |
| `branches unpause`                     | `wrapped`     | [`../src/legacy/commands/branches/unpause/unpause.command.ts`](../src/legacy/commands/branches/unpause/unpause.command.ts)                                                                |
| `branches delete`                      | `wrapped`     | [`../src/legacy/commands/branches/delete/delete.command.ts`](../src/legacy/commands/branches/delete/delete.command.ts)                                                                    |
| `branches disable`                     | `wrapped`     | [`../src/legacy/commands/branches/disable/disable.command.ts`](../src/legacy/commands/branches/disable/disable.command.ts)                                                                |
| `secrets list`                         | `ported`      | [`../src/legacy/commands/secrets/list/list.command.ts`](../src/legacy/commands/secrets/list/list.command.ts)                                                                              |
| `secrets set`                          | `ported`      | [`../src/legacy/commands/secrets/set/set.command.ts`](../src/legacy/commands/secrets/set/set.command.ts)                                                                                  |
| `secrets unset`                        | `ported`      | [`../src/legacy/commands/secrets/unset/unset.command.ts`](../src/legacy/commands/secrets/unset/unset.command.ts)                                                                          |
| `config push`                          | `wrapped`     | [`../src/legacy/commands/config/push/push.command.ts`](../src/legacy/commands/config/push/push.command.ts)                                                                                |
| `backups list`                         | `ported`      | [`../src/legacy/commands/backups/list/list.command.ts`](../src/legacy/commands/backups/list/list.command.ts)                                                                              |
| `backups restore`                      | `ported`      | [`../src/legacy/commands/backups/restore/restore.command.ts`](../src/legacy/commands/backups/restore/restore.command.ts)                                                                  |
| `snippets list`                        | `wrapped`     | [`../src/legacy/commands/snippets/list/list.command.ts`](../src/legacy/commands/snippets/list/list.command.ts)                                                                            |
| `snippets download`                    | `wrapped`     | [`../src/legacy/commands/snippets/download/download.command.ts`](../src/legacy/commands/snippets/download/download.command.ts)                                                            |
| `sso list`                             | `wrapped`     | [`../src/legacy/commands/sso/list/list.command.ts`](../src/legacy/commands/sso/list/list.command.ts)                                                                                      |
| `sso add`                              | `wrapped`     | [`../src/legacy/commands/sso/add/add.command.ts`](../src/legacy/commands/sso/add/add.command.ts)                                                                                          |
| `sso remove`                           | `wrapped`     | [`../src/legacy/commands/sso/remove/remove.command.ts`](../src/legacy/commands/sso/remove/remove.command.ts)                                                                              |
| `sso update`                           | `wrapped`     | [`../src/legacy/commands/sso/update/update.command.ts`](../src/legacy/commands/sso/update/update.command.ts)                                                                              |
| `sso show`                             | `wrapped`     | [`../src/legacy/commands/sso/show/show.command.ts`](../src/legacy/commands/sso/show/show.command.ts)                                                                                      |
| `sso info`                             | `wrapped`     | [`../src/legacy/commands/sso/info/info.command.ts`](../src/legacy/commands/sso/info/info.command.ts)                                                                                      |
| `domains create`                       | `wrapped`     | [`../src/legacy/commands/domains/create/create.command.ts`](../src/legacy/commands/domains/create/create.command.ts)                                                                      |
| `domains get`                          | `wrapped`     | [`../src/legacy/commands/domains/get/get.command.ts`](../src/legacy/commands/domains/get/get.command.ts)                                                                                  |
| `domains reverify`                     | `wrapped`     | [`../src/legacy/commands/domains/reverify/reverify.command.ts`](../src/legacy/commands/domains/reverify/reverify.command.ts)                                                              |
| `domains activate`                     | `wrapped`     | [`../src/legacy/commands/domains/activate/activate.command.ts`](../src/legacy/commands/domains/activate/activate.command.ts)                                                              |
| `domains delete`                       | `wrapped`     | [`../src/legacy/commands/domains/delete/delete.command.ts`](../src/legacy/commands/domains/delete/delete.command.ts)                                                                      |
| `vanity-subdomains get`                | `wrapped`     | [`../src/legacy/commands/vanity-subdomains/get/get.command.ts`](../src/legacy/commands/vanity-subdomains/get/get.command.ts)                                                              |
| `vanity-subdomains check-availability` | `wrapped`     | [`../src/legacy/commands/vanity-subdomains/check-availability/check-availability.command.ts`](../src/legacy/commands/vanity-subdomains/check-availability/check-availability.command.ts)  |
| `vanity-subdomains activate`           | `wrapped`     | [`../src/legacy/commands/vanity-subdomains/activate/activate.command.ts`](../src/legacy/commands/vanity-subdomains/activate/activate.command.ts)                                          |
| `vanity-subdomains delete`             | `wrapped`     | [`../src/legacy/commands/vanity-subdomains/delete/delete.command.ts`](../src/legacy/commands/vanity-subdomains/delete/delete.command.ts)                                                  |
| `network-bans get`                     | `wrapped`     | [`../src/legacy/commands/network-bans/get/get.command.ts`](../src/legacy/commands/network-bans/get/get.command.ts)                                                                        |
| `network-bans remove`                  | `wrapped`     | [`../src/legacy/commands/network-bans/remove/remove.command.ts`](../src/legacy/commands/network-bans/remove/remove.command.ts)                                                            |
| `network-restrictions get`             | `wrapped`     | [`../src/legacy/commands/network-restrictions/get/get.command.ts`](../src/legacy/commands/network-restrictions/get/get.command.ts)                                                        |
| `network-restrictions update`          | `wrapped`     | [`../src/legacy/commands/network-restrictions/update/update.command.ts`](../src/legacy/commands/network-restrictions/update/update.command.ts)                                            |
| `encryption get-root-key`              | `wrapped`     | [`../src/legacy/commands/encryption/get-root-key/get-root-key.command.ts`](../src/legacy/commands/encryption/get-root-key/get-root-key.command.ts)                                        |
| `encryption update-root-key`           | `wrapped`     | [`../src/legacy/commands/encryption/update-root-key/update-root-key.command.ts`](../src/legacy/commands/encryption/update-root-key/update-root-key.command.ts)                            |
| `ssl-enforcement get`                  | `ported`      | [`../src/legacy/commands/ssl-enforcement/get/get.command.ts`](../src/legacy/commands/ssl-enforcement/get/get.command.ts)                                                                  |
| `ssl-enforcement update`               | `ported`      | [`../src/legacy/commands/ssl-enforcement/update/update.command.ts`](../src/legacy/commands/ssl-enforcement/update/update.command.ts)                                                      |
| `postgres-config get`                  | `wrapped`     | [`../src/legacy/commands/postgres-config/get/get.command.ts`](../src/legacy/commands/postgres-config/get/get.command.ts)                                                                  |
| `postgres-config update`               | `wrapped`     | [`../src/legacy/commands/postgres-config/update/update.command.ts`](../src/legacy/commands/postgres-config/update/update.command.ts)                                                      |
| `postgres-config delete`               | `wrapped`     | [`../src/legacy/commands/postgres-config/delete/delete.command.ts`](../src/legacy/commands/postgres-config/delete/delete.command.ts)                                                      |
| `login`                                | `wrapped`     | [`../src/legacy/commands/login/login.command.ts`](../src/legacy/commands/login/login.command.ts)                                                                                          |
| `logout`                               | `wrapped`     | [`../src/legacy/commands/logout/logout.command.ts`](../src/legacy/commands/logout/logout.command.ts)                                                                                      |
| `link`                                 | `wrapped`     | [`../src/legacy/commands/link/link.command.ts`](../src/legacy/commands/link/link.command.ts)                                                                                              |
| `unlink`                               | `wrapped`     | [`../src/legacy/commands/unlink/unlink.command.ts`](../src/legacy/commands/unlink/unlink.command.ts)                                                                                      |
| `bootstrap`                            | `wrapped`     | [`../src/legacy/commands/bootstrap/bootstrap.command.ts`](../src/legacy/commands/bootstrap/bootstrap.command.ts)                                                                          |
| `init`                                 | `wrapped`     | [`../src/legacy/commands/init/init.command.ts`](../src/legacy/commands/init/init.command.ts)                                                                                              |
| `services`                             | `wrapped`     | [`../src/legacy/commands/services/services.command.ts`](../src/legacy/commands/services/services.command.ts)                                                                              |
| `start`                                | `wrapped`     | [`../src/legacy/commands/start/start.command.ts`](../src/legacy/commands/start/start.command.ts)                                                                                          |
| `stop`                                 | `wrapped`     | [`../src/legacy/commands/stop/stop.command.ts`](../src/legacy/commands/stop/stop.command.ts)                                                                                              |
| `status`                               | `wrapped`     | [`../src/legacy/commands/status/status.command.ts`](../src/legacy/commands/status/status.command.ts)                                                                                      |
| `migration list`                       | `wrapped`     | [`../src/legacy/commands/migration/list/list.command.ts`](../src/legacy/commands/migration/list/list.command.ts)                                                                          |
| `migration new`                        | `wrapped`     | [`../src/legacy/commands/migration/new/new.command.ts`](../src/legacy/commands/migration/new/new.command.ts)                                                                              |
| `migration repair`                     | `wrapped`     | [`../src/legacy/commands/migration/repair/repair.command.ts`](../src/legacy/commands/migration/repair/repair.command.ts)                                                                  |
| `migration squash`                     | `wrapped`     | [`../src/legacy/commands/migration/squash/squash.command.ts`](../src/legacy/commands/migration/squash/squash.command.ts)                                                                  |
| `migration up`                         | `wrapped`     | [`../src/legacy/commands/migration/up/up.command.ts`](../src/legacy/commands/migration/up/up.command.ts)                                                                                  |
| `migration down`                       | `wrapped`     | [`../src/legacy/commands/migration/down/down.command.ts`](../src/legacy/commands/migration/down/down.command.ts)                                                                          |
| `migration fetch`                      | `wrapped`     | [`../src/legacy/commands/migration/fetch/fetch.command.ts`](../src/legacy/commands/migration/fetch/fetch.command.ts)                                                                      |
| `gen types`                            | `wrapped`     | [`../src/legacy/commands/gen/types/types.command.ts`](../src/legacy/commands/gen/types/types.command.ts)                                                                                  |
| `gen signing-key`                      | `wrapped`     | [`../src/legacy/commands/gen/signing-key/signing-key.command.ts`](../src/legacy/commands/gen/signing-key/signing-key.command.ts)                                                          |
| `gen bearer-jwt`                       | `wrapped`     | [`../src/legacy/commands/gen/bearer-jwt/bearer-jwt.command.ts`](../src/legacy/commands/gen/bearer-jwt/bearer-jwt.command.ts)                                                              |
| `gen keys`                             | `wrapped`     | [`../src/legacy/commands/gen/keys/keys.command.ts`](../src/legacy/commands/gen/keys/keys.command.ts)                                                                                      |
| `functions list`                       | `wrapped`     | [`../src/legacy/commands/functions/list/list.command.ts`](../src/legacy/commands/functions/list/list.command.ts)                                                                          |
| `functions delete`                     | `wrapped`     | [`../src/legacy/commands/functions/delete/delete.command.ts`](../src/legacy/commands/functions/delete/delete.command.ts)                                                                  |
| `functions download`                   | `wrapped`     | [`../src/legacy/commands/functions/download/download.command.ts`](../src/legacy/commands/functions/download/download.command.ts)                                                          |
| `functions deploy`                     | `wrapped`     | [`../src/legacy/commands/functions/deploy/deploy.command.ts`](../src/legacy/commands/functions/deploy/deploy.command.ts)                                                                  |
| `functions new`                        | `wrapped`     | [`../src/legacy/commands/functions/new/new.command.ts`](../src/legacy/commands/functions/new/new.command.ts)                                                                              |
| `functions serve`                      | `wrapped`     | [`../src/legacy/commands/functions/serve/serve.command.ts`](../src/legacy/commands/functions/serve/serve.command.ts)                                                                      |
| `storage ls`                           | `wrapped`     | [`../src/legacy/commands/storage/ls/ls.command.ts`](../src/legacy/commands/storage/ls/ls.command.ts)                                                                                      |
| `storage cp`                           | `wrapped`     | [`../src/legacy/commands/storage/cp/cp.command.ts`](../src/legacy/commands/storage/cp/cp.command.ts)                                                                                      |
| `storage mv`                           | `wrapped`     | [`../src/legacy/commands/storage/mv/mv.command.ts`](../src/legacy/commands/storage/mv/mv.command.ts)                                                                                      |
| `storage rm`                           | `wrapped`     | [`../src/legacy/commands/storage/rm/rm.command.ts`](../src/legacy/commands/storage/rm/rm.command.ts)                                                                                      |
| `test db`                              | `wrapped`     | [`../src/legacy/commands/test/db/db.command.ts`](../src/legacy/commands/test/db/db.command.ts)                                                                                            |
| `test new`                             | `wrapped`     | [`../src/legacy/commands/test/new/new.command.ts`](../src/legacy/commands/test/new/new.command.ts)                                                                                        |
| `seed buckets`                         | `wrapped`     | [`../src/legacy/commands/seed/buckets/buckets.command.ts`](../src/legacy/commands/seed/buckets/buckets.command.ts)                                                                        |
| `db diff`                              | `wrapped`     | [`../src/legacy/commands/db/diff/diff.command.ts`](../src/legacy/commands/db/diff/diff.command.ts)                                                                                        |
| `db dump`                              | `wrapped`     | [`../src/legacy/commands/db/dump/dump.command.ts`](../src/legacy/commands/db/dump/dump.command.ts)                                                                                        |
| `db push`                              | `wrapped`     | [`../src/legacy/commands/db/push/push.command.ts`](../src/legacy/commands/db/push/push.command.ts)                                                                                        |
| `db pull`                              | `wrapped`     | [`../src/legacy/commands/db/pull/pull.command.ts`](../src/legacy/commands/db/pull/pull.command.ts) — includes `--diff-engine` (migra\|pg-delta, mutually exclusive with `--use-pg-delta`) |
| `db reset`                             | `wrapped`     | [`../src/legacy/commands/db/reset/reset.command.ts`](../src/legacy/commands/db/reset/reset.command.ts)                                                                                    |
| `db lint`                              | `wrapped`     | [`../src/legacy/commands/db/lint/lint.command.ts`](../src/legacy/commands/db/lint/lint.command.ts)                                                                                        |
| `db start`                             | `wrapped`     | [`../src/legacy/commands/db/start/start.command.ts`](../src/legacy/commands/db/start/start.command.ts)                                                                                    |
| `db query`                             | `wrapped`     | [`../src/legacy/commands/db/query/query.command.ts`](../src/legacy/commands/db/query/query.command.ts)                                                                                    |
| `db advisors`                          | `wrapped`     | [`../src/legacy/commands/db/advisors/advisors.command.ts`](../src/legacy/commands/db/advisors/advisors.command.ts)                                                                        |
| `db test`                              | `wrapped`     | [`../src/legacy/commands/db/test/test.command.ts`](../src/legacy/commands/db/test/test.command.ts)                                                                                        |
| `db branch create`                     | `wrapped`     | [`../src/legacy/commands/db/branch/create/create.command.ts`](../src/legacy/commands/db/branch/create/create.command.ts)                                                                  |
| `db branch delete`                     | `wrapped`     | [`../src/legacy/commands/db/branch/delete/delete.command.ts`](../src/legacy/commands/db/branch/delete/delete.command.ts)                                                                  |
| `db branch list`                       | `wrapped`     | [`../src/legacy/commands/db/branch/list/list.command.ts`](../src/legacy/commands/db/branch/list/list.command.ts)                                                                          |
| `db branch switch`                     | `wrapped`     | [`../src/legacy/commands/db/branch/switch/switch.command.ts`](../src/legacy/commands/db/branch/switch/switch.command.ts)                                                                  |
| `db remote changes`                    | `wrapped`     | [`../src/legacy/commands/db/remote/changes/changes.command.ts`](../src/legacy/commands/db/remote/changes/changes.command.ts)                                                              |
| `db remote commit`                     | `wrapped`     | [`../src/legacy/commands/db/remote/commit/commit.command.ts`](../src/legacy/commands/db/remote/commit/commit.command.ts)                                                                  |
| `db schema declarative sync`           | `wrapped`     | [`../src/legacy/commands/db/schema/declarative/sync/sync.command.ts`](../src/legacy/commands/db/schema/declarative/sync/sync.command.ts)                                                  |
| `db schema declarative generate`       | `wrapped`     | [`../src/legacy/commands/db/schema/declarative/generate/generate.command.ts`](../src/legacy/commands/db/schema/declarative/generate/generate.command.ts)                                  |
