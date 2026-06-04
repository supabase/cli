# `supabase branches get`

## Files Read

Same auth fallback chain (env / keyring / `~/.supabase/access-token`) and project-ref discovery (`<workdir>/supabase/.temp/project-ref`) as every Management-API legacy command.

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method | Path                                        | Auth         | When                                                                          | Response (used fields)                                                                  |
| ------ | ------------------------------------------- | ------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/branches/{name}`        | Bearer token | input is neither a UUID nor a `^[a-z]{20}$` ref pattern (named-branch lookup) | `{project_ref, ...}`                                                                    |
| `GET`  | `/v1/branches/{branch_id_or_ref}`           | Bearer token | always — branch detail / config                                               | `{ref, db_host, db_port, db_user?, db_pass?, jwt_secret?, postgres_version, status, …}` |
| `GET`  | `/v1/projects/{ref}/api-keys`               | Bearer token | only when `--output` is not `pretty`                                          | `[{name, api_key?}]`                                                                    |
| `GET`  | `/v1/projects/{ref}/config/database/pooler` | Bearer token | only when `--output` is not `pretty`                                          | `[SupavisorConfigResponse]` — handler filters for `database_type === "PRIMARY"`         |

## Environment Variables

`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_PROJECT_ID`, `SUPABASE_WORKDIR` — same semantics as `branches list`.

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success                                                                                 |
| `1`  | `LegacyBranchesFindUnexpectedStatusError` / `…NetworkError` — named-lookup phase failed |
| `1`  | `LegacyBranchesGetUnexpectedStatusError` / `…NetworkError` — detail phase failed        |
| `1`  | `LegacyBranchesApiKeysUnexpectedStatusError` / `…NetworkError` — api-keys phase failed  |
| `1`  | `LegacyBranchesPoolerUnexpectedStatusError` / `…NetworkError` — pooler phase failed     |
| `1`  | `LegacyBranchesPrimaryNotFoundError` — no `database_type === "PRIMARY"` pooler entry    |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                  |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output pretty` (Go default) / `--output-format text`

Glamour-styled 7-column table: `HOST`, `PORT`, `USER`, `PASSWORD`, `JWT SECRET`, `POSTGRES VERSION`, `STATUS`. Missing `db_user` / `db_pass` / `jwt_secret` render as `******`.

### `--output {json,yaml,toml,env}` / `--output-format json` / `stream-json`

Emits the standard-env projection: `POSTGRES_URL` (pooled, falls back to direct on parse failure with `WARNING:` to stderr), `POSTGRES_URL_NON_POOLING` (direct), `SUPABASE_URL = https://<ref>.<project_host>`, `SUPABASE_JWT_SECRET`, plus `SUPABASE_<NAME>_KEY` per API key.
