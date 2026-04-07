# Go CLI Porting Status

Manual parity tracker for the TypeScript CLI port. Update this file whenever a command is added or parity changes.

Reference:

- Old Go CLI help dump: [`go-cli-reference.md`](./go-cli-reference.md)
- Current TS root command: [`../src/cli/root.ts`](../src/cli/root.ts)

## Legend

- `ported`: TS command exists and the flag/parameter surface is materially aligned with the old Go CLI
- `partial`: TS feature exists but differs materially from the old Go CLI shape, flag surface, or invocation style. This includes feature parity delivered through framework-built global flags such as `--help` and `--completions` instead of matching Go subcommands exactly.
- `missing`: no TS command/subcommand exists yet

Percentages and counts below are based on final leaf commands only. Command groups like `db`, `functions`, and `completion` are not counted as commands.

## Summary

| Metric                    |   Count | Percent |
| ------------------------- | ------: | ------: |
| Fully ported commands     |  2 / 94 |    2.1% |
| Partially ported commands | 59 / 94 |   62.8% |

## Family Summary

| Family                    | Final commands |  `ported` |  `partial` | `missing` | Represented in TS |
| ------------------------- | -------------: | --------: | ---------: | --------: | ----------------: |
| Quick Start               |              1 |    0 (0%) |     0 (0%) |  1 (100%) |            0 (0%) |
| Project / Stack Lifecycle |              9 | 2 (22.2%) |  7 (77.8%) |    0 (0%) |          9 (100%) |
| Database                  |             19 |    0 (0%) |     0 (0%) | 19 (100%) |            0 (0%) |
| Code Generation           |              3 |    0 (0%) |     0 (0%) |  3 (100%) |            0 (0%) |
| Functions                 |              6 |    0 (0%) |     0 (0%) |  6 (100%) |            0 (0%) |
| Storage                   |              4 |    0 (0%) |     0 (0%) |  4 (100%) |            0 (0%) |
| Management APIs           |             47 |    0 (0%) |  47 (100%) |    0 (0%) |         47 (100%) |
| Additional Commands       |              5 |    0 (0%) | 5 (100.0%) |    0 (0%) |        5 (100.0%) |

## Global Flags Overview

This tracker is command-focused, but root global flag drift is large enough to note separately.

| Surface                 | TS path                                                    | Missing old flags/params                                                                                                        | Extra TS flags/params | Notes                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase` global flags | [`../src/cli/global-flags.ts`](../src/cli/global-flags.ts) | `--create-ticket`, `--debug`, `--dns-resolver`, `--experimental`, `--network-id`, `--output`, `--profile`, `--workdir`, `--yes` | `--output-format`     | Root flag parity is still far from the Go CLI, but the framework already provides global `--help` and `--completions`, so help and shell completion have feature parity even though they no longer live under explicit Go-style subcommands. |

## TS-only Commands

These commands exist in the TS CLI today but have no direct top-level equivalent in the old Go CLI reference.

| TS command        | TS path                                                                                                  | Notes                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`             | `planned`                                                                                                | Reserved for a TS-native long-running local development workflow command that watches files and orchestrates subcommands. Track this as TS-only unless a direct Go equivalent emerges. |
| `logs`            | [`../src/commands/logs/logs.command.ts`](../src/commands/logs/logs.command.ts)                           | Streams local stack logs. No top-level `logs` command exists in the old Go CLI reference.                                                                                              |
| `platform`        | [`../src/commands/platform/platform.command.ts`](../src/commands/platform/platform.command.ts)           | Generated Management API command tree. It supersedes the old top-level management families with a schema-driven surface rooted at `supabase platform ...`.                             |
| `stack`           | [`../src/cli/root.ts`](../src/cli/root.ts)                                                               | TS-only local runtime namespace exposing `stack start`, `stack stop`, `stack status`, `stack list`, and `stack update`. Top-level `start`, `stop`, and `status` remain aliases.        |
| `branches switch` | [`../src/commands/branches/switch/switch.command.ts`](../src/commands/branches/switch/switch.command.ts) | No direct Go equivalent. Updates local active-branch state so subsequent commands target the selected branch.                                                                          |

## Quick Start

| Old command | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes              |
| ----------- | --------- | ---------------------------- | -------------------- | --------------------- | ------------------ |
| `bootstrap` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS command yet. |

## Project / Stack Lifecycle

| Old command | TS status | TS command path or `missing`                                                           | Missing flags/params                                                                                                                                                              | Extra TS flags/params                      | Notes                                                                                                                                                                                                                                                                                         |
| ----------- | --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`      | `partial` | [`../src/commands/init/init.command.ts`](../src/commands/init/init.command.ts)         | `--force`, `--interactive`, `--use-orioledb`                                                                                                                                      | `-`                                        | TS init creates a minimal `supabase/config.json` with only a `"$schema"` reference and ensures repo-local `.supabase/` state can stay gitignored, but it does not yet expose the old Go flag surface.                                                                                         |
| `link`      | `partial` | [`../src/commands/link/link.command.ts`](../src/commands/link/link.command.ts)         | `--password`, `--skip-pooler`                                                                                                                                                     | `-`                                        | TS link supports `--project-ref`, interactive project selection, and zero-config linking. It stores linked remote metadata in repo-local `.supabase/project.json`, but it does not yet manage direct database-password or pooler-specific link flows.                                         |
| `unlink`    | `ported`  | [`../src/commands/unlink/unlink.command.ts`](../src/commands/unlink/unlink.command.ts) | `-`                                                                                                                                                                               | `-`                                        | TS unlink matches the current Go surface and removes the repo-local linked project metadata for the active checkout.                                                                                                                                                                          |
| `login`     | `ported`  | [`../src/commands/login/login.command.ts`](../src/commands/login/login.command.ts)     | `-`                                                                                                                                                                               | `-`                                        | Flag surface matches the old CLI: `--token`, `--name`, `--no-browser`. TS also supports env-var and piped-stdin token input without adding new flags.                                                                                                                                         |
| `logout`    | `partial` | [`../src/commands/logout/logout.command.ts`](../src/commands/logout/logout.command.ts) | `-`                                                                                                                                                                               | `--yes`                                    | TS adds `--yes` to skip the confirmation prompt in non-interactive / scripted contexts. No equivalent flag in the Go CLI, so this remains partial rather than fully ported.                                                                                                                   |
| `start`     | `partial` | [`../src/commands/start/start.command.ts`](../src/commands/start/start.command.ts)     | `--ignore-health-check`, `--sandbox`; legacy `--exclude` names like `gotrue`, `storage-api`, `postgres-meta`, `edge-runtime`, `logflare`, `supavisor`, and `kong` are not aligned | `--stack`, `--service-version`, `--detach` | TS start supports foreground and detached modes, named managed stacks, pinned stack baselines, linked/local/per-run service version overrides, and exclusions for `auth`, `postgrest`, `realtime`, `storage`, `imgproxy`, `mailpit`, `pgmeta`, `studio`, `analytics`, `vector`, and `pooler`. |
| `stop`      | `partial` | [`../src/commands/stop/stop.command.ts`](../src/commands/stop/stop.command.ts)         | `--all`, `--project-id`                                                                                                                                                           | `--stack`                                  | Current TS stop only covers one project-scoped managed stack at a time. It supports `--no-backup`, can target non-default stack names with `--stack`, and preserves pinned stack metadata unless `--no-backup` is used.                                                                       |
| `status`    | `partial` | [`../src/commands/status/status.command.ts`](../src/commands/status/status.command.ts) | `--override-name`                                                                                                                                                                 | `--stack`                                  | Current TS status shows a detailed running or stopped view for one project-scoped managed stack and reports whether pinned stack versions are up to date against the cached linked/default baseline.                                                                                          |
| `services`  | `partial` | `supabase status` + `supabase stack update`                                            | Go-style dedicated `services` command shape                                                                                                                                       | `--stack`                                  | The old version-reporting and linked-version drift behavior exists in TS, but it is split across `status` for per-service versions and `stack update` for refreshing pinned versions instead of a single `services` command.                                                                  |

## Database

| Old command        | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                 |
| ------------------ | --------- | ---------------------------- | -------------------- | --------------------- | --------------------- |
| `db diff`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db dump`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db lint`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db pull`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db push`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db reset`         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `db start`         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `inspect db`       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `inspect report`   | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration down`   | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration fetch`  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration list`   | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration new`    | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration repair` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration squash` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `migration up`     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `seed buckets`     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `test db`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `test new`         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |

## Code Generation

| Old command       | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                 |
| ----------------- | --------- | ---------------------------- | -------------------- | --------------------- | --------------------- |
| `gen bearer-jwt`  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `gen signing-key` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `gen types`       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |

## Functions

The old Go `functions` family mixed linked-project operations (`list`, `deploy`, `download`, `delete`) with local-development workflows (`new`, `serve`).

Current TS only exposes generated Management API routes under [`platform`](../src/commands/platform/platform.command.ts). This tracker does not count those routes as parity for the old `functions` command family, because there is still no dedicated TS `functions` CLI surface and no local Functions workflow equivalent.

| Old command          | TS status | New TS counterpart(s) | Notes                                                                                                                                |
| -------------------- | --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `functions delete`   | `missing` | `missing`             | Remote Management API routes exist under `supabase platform ...`, but there is no dedicated TS `functions delete` command surface.   |
| `functions deploy`   | `missing` | `missing`             | Remote Management API routes exist under `supabase platform ...`, but there is no dedicated TS `functions deploy` command surface.   |
| `functions download` | `missing` | `missing`             | Remote Management API routes exist under `supabase platform ...`, but there is no dedicated TS `functions download` command surface. |
| `functions list`     | `missing` | `missing`             | Remote Management API routes exist under `supabase platform ...`, but there is no dedicated TS `functions list` command surface.     |
| `functions new`      | `missing` | `missing`             | No TS local scaffold command yet.                                                                                                    |
| `functions serve`    | `missing` | `missing`             | No TS local Functions serving command yet.                                                                                           |

## Storage

The old Go `storage` family could target either the linked project or the local Storage API via `--linked` / `--local`.

Current TS only exposes generated Management API routes under [`platform`](../src/commands/platform/platform.command.ts). This tracker does not count those routes as parity for the old `storage` object-management CLI surface, especially because there is no TS equivalent for the old local Storage API workflow.

| Old command  | TS status | New TS counterpart(s) | Notes                                                                 |
| ------------ | --------- | --------------------- | --------------------------------------------------------------------- |
| `storage cp` | `missing` | `missing`             | No TS object copy command for linked or local Storage API targets.    |
| `storage ls` | `missing` | `missing`             | No TS object listing command for linked or local Storage API targets. |
| `storage mv` | `missing` | `missing`             | No TS object move command for linked or local Storage API targets.    |
| `storage rm` | `missing` | `missing`             | No TS object remove command for linked or local Storage API targets.  |

## Management APIs

The remaining old Go Management API surface has been replaced by the generated [`platform`](../src/commands/platform/platform.command.ts) tree.

That means parity is no longer 1:1 at the flag level, but the capability coverage is now broader than the old Go surface:

- every current Management API OpenAPI route is exposed through `supabase platform ...`
- the metadata test in [`../src/commands/platform/platform-metadata.unit.test.ts`](../src/commands/platform/platform-metadata.unit.test.ts) verifies that every exported SDK/OpenAPI operation is represented exactly once
- because the public UX is intentionally different, these commands are tracked as `partial` rather than `ported`

Common input drift across all Management API mappings:

- missing old command-specific flags/parameters:
  the old hand-written subcommand flags are generally replaced by the generic `platform` input model
- extra TS flags/parameters:
  `--params`, `--json`, `--body`, `--body-file`, `--upload`, `--fields`, `--schema`, `--dry-run`, `--yes`

| Old Go family / command                | TS status | New TS counterpart(s)                                                  | Notes                                                                                                                                                                                                                                                             |
| -------------------------------------- | --------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backups list`                         | `partial` | `supabase platform projects database backups list`                     | Backup listing now lives under the project-scoped database tree.                                                                                                                                                                                                  |
| `backups restore`                      | `partial` | `supabase platform projects database backups restore-pitr restore`     | The generated tree also exposes restore-point and undo routes that did not exist as old leaf commands.                                                                                                                                                            |
| `branches create`                      | `ported`  | `supabase branches create`                                             | Supports --region, --size, --persistent, --with-data, --notify-url, --switch; auto-detects git branch name with interactive confirmation or CI auto-use. Extra TS flag: --switch (set new branch as active immediately; otherwise prompts in TTY or skips in CI). |
| `branches delete`                      | `partial` | `supabase platform branches delete`                                    | Destructive branch lifecycle helpers are split across `projects.branches.*` and top-level `branches.*` operations.                                                                                                                                                |
| `branches get`                         | `partial` | `supabase platform projects branches get`                              |                                                                                                                                                                                                                                                                   |
| `branches list`                        | `ported`  | `supabase branches list`                                               |                                                                                                                                                                                                                                                                   |
| `branches pause`                       | `partial` | `supabase platform projects pause`                                     | The old preview-branch pause UX is not preserved 1:1; use the generated project/branch operations exposed by `platform schema`.                                                                                                                                   |
| `branches unpause`                     | `partial` | `supabase platform branches restore`                                   | Branch recovery helpers are now explicit generated operations instead of a dedicated `unpause` leaf.                                                                                                                                                              |
| `branches update`                      | `partial` | `supabase platform branches update`                                    |                                                                                                                                                                                                                                                                   |
| `config push`                          | `partial` | `supabase platform projects config ...`                                | Project config is now split into generated auth, database, realtime, storage, disk, and related config operations.                                                                                                                                                |
| `domains activate`                     | `partial` | `supabase platform projects custom-hostname activate`                  | Custom hostname operations replace the old `domains` family.                                                                                                                                                                                                      |
| `domains create`                       | `partial` | `supabase platform projects custom-hostname initialize update`         |                                                                                                                                                                                                                                                                   |
| `domains delete`                       | `partial` | `supabase platform projects custom-hostname delete`                    |                                                                                                                                                                                                                                                                   |
| `domains get`                          | `partial` | `supabase platform projects custom-hostname get`                       |                                                                                                                                                                                                                                                                   |
| `domains reverify`                     | `partial` | `supabase platform projects custom-hostname reverify verify`           |                                                                                                                                                                                                                                                                   |
| `encryption get-root-key`              | `partial` | `supabase platform projects pgsodium get`                              | The old standalone encryption-root-key surface no longer exists verbatim; current OpenAPI coverage is represented by project encryption/config routes.                                                                                                            |
| `encryption update-root-key`           | `partial` | `supabase platform projects pgsodium update`                           |                                                                                                                                                                                                                                                                   |
| `network-bans get`                     | `partial` | `supabase platform projects network-bans retrieve list`                |                                                                                                                                                                                                                                                                   |
| `network-bans remove`                  | `partial` | `supabase platform projects network-bans delete`                       |                                                                                                                                                                                                                                                                   |
| `network-restrictions get`             | `partial` | `supabase platform projects network-restrictions list`                 |                                                                                                                                                                                                                                                                   |
| `network-restrictions update`          | `partial` | `supabase platform projects network-restrictions apply update`         | Patch-style helpers are also exposed separately.                                                                                                                                                                                                                  |
| `orgs create`                          | `partial` | `supabase platform organizations create`                               |                                                                                                                                                                                                                                                                   |
| `orgs list`                            | `partial` | `supabase platform organizations list`                                 |                                                                                                                                                                                                                                                                   |
| `postgres-config delete`               | `partial` | `supabase platform projects config database postgres update`           | The current OpenAPI surface exposes list/update rather than the old delete/get/update trio.                                                                                                                                                                       |
| `postgres-config get`                  | `partial` | `supabase platform projects config database postgres list`             |                                                                                                                                                                                                                                                                   |
| `postgres-config update`               | `partial` | `supabase platform projects config database postgres update`           |                                                                                                                                                                                                                                                                   |
| `projects api-keys`                    | `partial` | `supabase platform projects api-keys list`                             | The generated tree also exposes create/get/update/delete and legacy-key operations.                                                                                                                                                                               |
| `projects create`                      | `partial` | `supabase platform projects create`                                    |                                                                                                                                                                                                                                                                   |
| `projects delete`                      | `partial` | `supabase platform projects delete`                                    |                                                                                                                                                                                                                                                                   |
| `projects list`                        | `partial` | `supabase platform projects list`                                      |                                                                                                                                                                                                                                                                   |
| `secrets list`                         | `partial` | `supabase platform projects secrets list`                              |                                                                                                                                                                                                                                                                   |
| `secrets set`                          | `partial` | `supabase platform projects secrets bulk-create`                       |                                                                                                                                                                                                                                                                   |
| `secrets unset`                        | `partial` | `supabase platform projects secrets bulk-delete`                       |                                                                                                                                                                                                                                                                   |
| `snippets download`                    | `partial` | `supabase platform snippets get`                                       |                                                                                                                                                                                                                                                                   |
| `snippets list`                        | `partial` | `supabase platform snippets list`                                      |                                                                                                                                                                                                                                                                   |
| `ssl-enforcement get`                  | `partial` | `supabase platform projects ssl-enforcement get`                       |                                                                                                                                                                                                                                                                   |
| `ssl-enforcement update`               | `partial` | `supabase platform projects ssl-enforcement update`                    |                                                                                                                                                                                                                                                                   |
| `sso add`                              | `partial` | `supabase platform projects config auth sso providers create`          |                                                                                                                                                                                                                                                                   |
| `sso info`                             | `partial` | `supabase platform projects config auth sso providers get`             |                                                                                                                                                                                                                                                                   |
| `sso list`                             | `partial` | `supabase platform projects config auth sso providers list`            |                                                                                                                                                                                                                                                                   |
| `sso remove`                           | `partial` | `supabase platform projects config auth sso providers delete`          |                                                                                                                                                                                                                                                                   |
| `sso show`                             | `partial` | `supabase platform projects config auth sso providers get`             |                                                                                                                                                                                                                                                                   |
| `sso update`                           | `partial` | `supabase platform projects config auth sso providers update`          |                                                                                                                                                                                                                                                                   |
| `vanity-subdomains activate`           | `partial` | `supabase platform projects vanity-subdomain activate`                 |                                                                                                                                                                                                                                                                   |
| `vanity-subdomains check-availability` | `partial` | `supabase platform projects vanity-subdomain check-availability check` |                                                                                                                                                                                                                                                                   |
| `vanity-subdomains delete`             | `partial` | `supabase platform projects vanity-subdomain deactivate`               |                                                                                                                                                                                                                                                                   |
| `vanity-subdomains get`                | `partial` | `supabase platform projects vanity-subdomain get`                      |                                                                                                                                                                                                                                                                   |

## Additional Commands

| Old command             | TS status | TS command path or `missing`        | Missing flags/params                              | Extra TS flags/params | Notes                                                                                                                |
| ----------------------- | --------- | ----------------------------------- | ------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `completion bash`       | `partial` | `supabase --completions bash`       | Go-style `completion bash` subcommand shape       | `-`                   | Feature parity exists via the framework-provided global `--completions` flag instead of a dedicated subcommand tree. |
| `completion fish`       | `partial` | `supabase --completions fish`       | Go-style `completion fish` subcommand shape       | `-`                   | Feature parity exists via the framework-provided global `--completions` flag instead of a dedicated subcommand tree. |
| `completion powershell` | `partial` | `supabase --completions powershell` | Go-style `completion powershell` subcommand shape | `-`                   | Feature parity exists via the framework-provided global `--completions` flag instead of a dedicated subcommand tree. |
| `completion zsh`        | `partial` | `supabase --completions zsh`        | Go-style `completion zsh` subcommand shape        | `-`                   | Feature parity exists via the framework-provided global `--completions` flag instead of a dedicated subcommand tree. |
| `help`                  | `partial` | `supabase --help`                   | Go-style top-level `help` command shape           | `-`                   | Feature parity exists via the framework-provided global `--help` flag instead of a dedicated `help` command.         |
