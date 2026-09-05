# `supabase storage ls [path]`

Lists objects/buckets by path prefix against the Storage gateway (local stack or linked project).

## Files Read

| Path                                          | Format     | When                                                                                                                                                             |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`              | TOML       | always (local creds/baseUrl; `[remotes.*]` merge when linked)                                                                                                    |
| `~/.supabase/access-token`                    | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                  |
| `~/.supabase/<hash>/linked-project.json`      | JSON       | linked path, to resolve the project ref                                                                                                                          |
| local Kong TLS cert/key                       | PEM        | local + `api.enabled` + `api.tls.enabled`                                                                                                                        |
| `<workdir>/supabase/.env*`, `<workdir>/.env*` | dotenv     | local path, to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key |

## Files Written

| Path                                     | Format | When                              |
| ---------------------------------------- | ------ | --------------------------------- |
| `~/.supabase/<hash>/linked-project.json` | JSON   | post-run, linked path (ref cache) |
| `~/.supabase/telemetry.json`             | JSON   | post-run (always)                 |

## API Routes

Auth: `apikey` header always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body                            | Response (used)                 |
| ------ | ----------------------------------------- | --------------------------------------- | ------------------------------- |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` | `[{name, id?}]` (id null ⇒ dir) |
| `GET`  | `/storage/v1/bucket`                      | —                                       | `[{name, id}]`                  |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (linked, Management API)              | api-key list → service-role key |

## Environment Variables

| Variable                                                                                                                                                        | Purpose                                                                                                                | Required?                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY`                                                                                                                                | linked: bypass tenant key fetch (shell env only); local: explicit key, shell or project dotenv, `encrypted:` decrypted | no                                 |
| `SUPABASE_AUTH_JWT_SECRET`                                                                                                                                      | local: derive service-role key, shell or project dotenv, `encrypted:` decrypted                                        | no (→ `auth.jwt_secret` → default) |
| `SUPABASE_ACCESS_TOKEN`                                                                                                                                         | linked: Management API auth                                                                                            | no (→ `~/.supabase/access-token`)  |
| `SUPABASE_PROJECT_ID`                                                                                                                                           | linked: project-ref resolution, superseded by `--project-ref` when set                                                 | no                                 |
| `SUPABASE_SERVICES_HOSTNAME`                                                                                                                                    | local baseUrl host                                                                                                     | no (→ Docker host → `127.0.0.1`)   |
| `SUPABASE_API_PORT`, `SUPABASE_API_EXTERNAL_URL`, `SUPABASE_API_TLS_ENABLED`, `SUPABASE_API_TLS_CERT_PATH`, `SUPABASE_API_TLS_KEY_PATH`, `SUPABASE_API_ENABLED` | local: override the matching `[api]` fields for the gateway URL/TLS, shell env or project dotenv (shell wins; #6452)   | no                                 |
| `SUPABASE_EXPERIMENTAL`                                                                                                                                         | experimental gate: `--experimental` equivalent                                                                         | yes, unless `--experimental` given |

`storage` is an experimental command: every subcommand requires
`--experimental` (or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success                                                                     |
| `1`  | invalid URL / url-parse error / API non-2xx / network / auth / config parse |
| `1`  | `--project-ref` set with `--local` (see Notes)                              |

## Output

### `--output-format text`

One entry per line to **stdout**; directory entries get a trailing `/`.
Pagination prints `Loading page: <N>` to **stderr**.

### `--output-format json`

```json
{ "paths": ["bucket/", "bucket/folder/file.png"] }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"paths":["bucket/","bucket/folder/file.png"]}}
```

## Telemetry Events Fired

| Event                  | When                                       | Notable properties               |
| ---------------------- | ------------------------------------------ | -------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/linked/local) |

No custom storage telemetry events.

## Notes

- Default path is `ss:///` (all buckets root) → remotePath `/`; recursive file paths
  then carry a leading slash, while an empty bucket is reported bare as `<bucket>/`.
- `--recursive`/`-r` walks the tree (BFS).
- **`--project-ref`** (TS-only, no Go equivalent) overrides ONLY the linked-ref
  resolution used above (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`).
  It never implies `--linked`: passing it with `--local` is a hard error
  rather than a silently discarded flag.
- `--local` / `--linked` are mutually exclusive; `--local` routes to the local stack,
  otherwise the linked project is used. They are declared **per-leaf** (not as
  `storage`-group scoped globals) because Effect CLI requires global-flag names to be
  unique tree-wide and `seed` already owns `linked`/`local`; the only behavioural cost
  is that they must follow the subcommand token
  (`storage ls --local`, not `storage --local ls`) — the same shape the `db` family uses.
