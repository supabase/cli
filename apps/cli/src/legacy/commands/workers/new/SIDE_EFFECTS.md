# `supabase workers new [name]`

> **TS-only command.** `supabase workers` has no Go counterpart — there is no
> `apps/cli-go/internal/workers` to match, and nothing is proxied. See
> `docs/go-cli-divergences.md`.

## Files Read

| Path                             | Format | When                                                        |
| -------------------------------- | ------ | ----------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, for `[workers]` root and any existing entry         |
| `<destination>/`                 | dir    | always, to refuse a non-empty destination without `--force` |

## Files Written

| Path                                 | Format | When                                                                      |
| ------------------------------------ | ------ | ------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`     | TOML   | always — appends/updates `[workers.<name>]` in place, preserving comments |
| `<workdir>/supabase/<root>/<name>/*` | varies | always, unless `--source` names another directory                         |
| `<workdir>/<source>/*`               | varies | when `--source` is given                                                  |

Existing files at the destination are **deleted** when `--force` is passed.
`--source` is refused when it resolves to the project root, `supabase/`,
`supabase/functions/`, `supabase/migrations/`, or outside the project.

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Exit Codes

| Code | Condition                                                             |
| ---- | --------------------------------------------------------------------- |
| `0`  | success                                                               |
| `1`  | invalid or reserved worker name, unknown runtime/size, bad `--source` |
| `1`  | destination exists and is not empty without `--force`                 |
| `1`  | `config.toml` records a worker in a form that cannot be edited safely |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |
| `SUPABASE_WORKDIR`      | project directory the command acts on                | no (falls back to `--workdir`, then the ancestor walk)  |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events. `workers` has no Go counterpart, so there is no
`phtelemetry.*` call to reproduce.
