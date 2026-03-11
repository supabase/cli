# Go CLI Porting Status

Manual parity tracker for the TypeScript CLI port. Update this file whenever a command is added or parity changes.

Reference:

- Old Go CLI help dump: [`go-cli-reference.md`](./go-cli-reference.md)
- Current TS root command: [`../src/cli/root.ts`](../src/cli/root.ts)

## Legend

- `ported`: TS command exists and the flag/parameter surface is materially aligned with the old Go CLI
- `partial`: TS command exists but is missing flags/parameters or adds TS-only flags/parameters
- `missing`: no TS command/subcommand exists yet

Percentages and counts below are based on final leaf commands only. Command groups like `db`, `functions`, and `completion` are not counted as commands.

## Summary

| Metric                    |  Count | Percent |
| ------------------------- | -----: | ------: |
| Fully ported commands     | 1 / 94 |    1.1% |
| Partially ported commands | 3 / 94 |    3.2% |

## Family Summary

| Family              | Final commands | `ported` | `partial` |  `missing` | Represented in TS |
| ------------------- | -------------: | -------: | --------: | ---------: | ----------------: |
| Quick Start         |              1 |   0 (0%) |    0 (0%) |   1 (100%) |            0 (0%) |
| Local Development   |             31 | 1 (3.2%) |  3 (9.7%) | 27 (87.1%) |         4 (12.9%) |
| Management APIs     |             57 |   0 (0%) |    0 (0%) |  57 (100%) |            0 (0%) |
| Additional Commands |              5 |   0 (0%) |    0 (0%) |   5 (100%) |            0 (0%) |

## Global Flags Overview

This tracker is command-focused, but root global flag drift is large enough to note separately.

| Surface                 | TS path                                                    | Missing old flags/params                                                                                                        | Extra TS flags/params                                  | Notes                                                                                            |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `supabase` global flags | [`../src/cli/global-flags.ts`](../src/cli/global-flags.ts) | `--create-ticket`, `--debug`, `--dns-resolver`, `--experimental`, `--network-id`, `--output`, `--profile`, `--workdir`, `--yes` | `--output-format`, `--usage`, `--skill`, `--skill-dir` | Root flag parity is still far from the Go CLI. `--help` exists implicitly via the CLI framework. |

## TS-only Commands

These commands exist in the TS CLI today but have no direct top-level equivalent in the old Go CLI reference.

| TS command | TS path                                                                        | Notes                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`      | `planned`                                                                      | Reserved for a TS-native long-running local development workflow command that watches files and orchestrates subcommands. Track this as TS-only unless a direct Go equivalent emerges. |
| `logs`     | [`../src/commands/logs/logs.command.ts`](../src/commands/logs/logs.command.ts) | Streams local stack logs. No top-level `logs` command exists in the old Go CLI reference.                                                                                              |

## Quick Start

| Old command | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes              |
| ----------- | --------- | ---------------------------- | -------------------- | --------------------- | ------------------ |
| `bootstrap` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS command yet. |

## Local Development

| Old command        | TS status | TS command path or `missing`                                                           | Missing flags/params                                                                         | Extra TS flags/params | Notes                                                                                                                                                 |
| ------------------ | --------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`             | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS command yet.                                                                                                                                    |
| `link`             | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS command yet.                                                                                                                                    |
| `unlink`           | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS command yet.                                                                                                                                    |
| `login`            | `ported`  | [`../src/commands/login/login.command.ts`](../src/commands/login/login.command.ts)     | `-`                                                                                          | `-`                   | Flag surface matches the old CLI: `--token`, `--name`, `--no-browser`. TS also supports env-var and piped-stdin token input without adding new flags. |
| `logout`           | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS command yet.                                                                                                                                    |
| `start`            | `partial` | [`../src/commands/start/start.command.ts`](../src/commands/start/start.command.ts)     | `--ignore-health-check`, `--sandbox`; `--exclude` only supports `auth` and `postgrest` today | `--detach`            | TS start supports foreground and background modes, but the old Go surface is broader.                                                                 |
| `stop`             | `partial` | [`../src/commands/stop/stop.command.ts`](../src/commands/stop/stop.command.ts)         | `--all`, `--no-backup`, `--project-id`                                                       | `-`                   | Current TS stop only covers the active local stack.                                                                                                   |
| `status`           | `partial` | [`../src/commands/status/status.command.ts`](../src/commands/status/status.command.ts) | `--override-name`                                                                            | `-`                   | Current TS status covers local stack status but not output variable-name overrides.                                                                   |
| `services`         | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS command yet.                                                                                                                                    |
| `db diff`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db dump`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db lint`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db pull`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db push`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db reset`         | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `db start`         | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `gen bearer-jwt`   | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `gen signing-key`  | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `gen types`        | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `inspect db`       | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `inspect report`   | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration down`   | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration fetch`  | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration list`   | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration new`    | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration repair` | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration squash` | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `migration up`     | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `seed buckets`     | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `test db`          | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |
| `test new`         | `missing` | `missing`                                                                              | `n/a`                                                                                        | `n/a`                 | No TS subcommand yet.                                                                                                                                 |

## Management APIs

| Old command                            | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                 |
| -------------------------------------- | --------- | ---------------------------- | -------------------- | --------------------- | --------------------- |
| `backups list`                         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `backups restore`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches create`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches delete`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches get`                         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches list`                        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches pause`                       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches unpause`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `branches update`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `config push`                          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `domains activate`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `domains create`                       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `domains delete`                       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `domains get`                          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `domains reverify`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `encryption get-root-key`              | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `encryption update-root-key`           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions delete`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions deploy`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions download`                   | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions list`                       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions new`                        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `functions serve`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `network-bans get`                     | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `network-bans remove`                  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `network-restrictions get`             | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `network-restrictions update`          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `orgs create`                          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `orgs list`                            | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `postgres-config delete`               | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `postgres-config get`                  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `postgres-config update`               | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `projects api-keys`                    | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `projects create`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `projects delete`                      | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `projects list`                        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `secrets list`                         | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `secrets set`                          | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `secrets unset`                        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `snippets download`                    | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `snippets list`                        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `ssl-enforcement get`                  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `ssl-enforcement update`               | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso add`                              | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso info`                             | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso list`                             | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso remove`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso show`                             | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `sso update`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `storage cp`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `storage ls`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `storage mv`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `storage rm`                           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `vanity-subdomains activate`           | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `vanity-subdomains check-availability` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `vanity-subdomains delete`             | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |
| `vanity-subdomains get`                | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet. |

## Additional Commands

| Old command             | TS status | TS command path or `missing` | Missing flags/params | Extra TS flags/params | Notes                                                                  |
| ----------------------- | --------- | ---------------------------- | -------------------- | --------------------- | ---------------------------------------------------------------------- |
| `completion bash`       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet.                                                  |
| `completion fish`       | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet.                                                  |
| `completion powershell` | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet.                                                  |
| `completion zsh`        | `missing` | `missing`                    | `n/a`                | `n/a`                 | No TS subcommand yet.                                                  |
| `help`                  | `missing` | `missing`                    | `n/a`                | `n/a`                 | No explicit TS help command yet; help is currently framework-provided. |
