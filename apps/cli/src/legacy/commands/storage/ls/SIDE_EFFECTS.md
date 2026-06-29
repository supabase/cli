# `supabase storage ls [path]`

Native TypeScript port of `apps/cli-go/internal/storage/ls`. Lists objects/buckets
by path prefix against the Storage gateway (local stack or linked project).

## Files Read

| Path                                     | Format     | When                                                          |
| ---------------------------------------- | ---------- | ------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML       | always (local creds/baseUrl; `[remotes.*]` merge when linked) |
| `~/.supabase/access-token`               | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset               |
| `~/.supabase/<hash>/linked-project.json` | JSON       | linked path, to resolve the project ref                       |
| local Kong TLS cert/key                  | PEM        | local + `api.enabled` + `api.tls.enabled`                     |

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

| Variable                         | Purpose                                              | Required?                          |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY` | linked: bypass tenant key fetch; local: explicit key | no                                 |
| `SUPABASE_AUTH_JWT_SECRET`       | local: derive service-role key                       | no (→ `auth.jwt_secret` → default) |
| `SUPABASE_ACCESS_TOKEN`          | linked: Management API auth                          | no (→ `~/.supabase/access-token`)  |
| `SUPABASE_PROJECT_ID`            | linked: project-ref resolution                       | no                                 |
| `SUPABASE_SERVICES_HOSTNAME`     | local baseUrl host                                   | no (→ Docker host → `127.0.0.1`)   |
| `SUPABASE_EXPERIMENTAL`          | experimental gate: `--experimental` equivalent       | yes, unless `--experimental` given |

`storage` is an experimental command (Go `root.go:63`): every subcommand requires
`--experimental` (or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                   |
| ---- | --------------------------------------------------------------------------- |
| `0`  | success                                                                     |
| `1`  | invalid URL / url-parse error / API non-2xx / network / auth / config parse |

## Output

### `--output-format text` (Go CLI compatible)

One entry per line to **stdout** (`fmt.Println`); directory entries get a trailing `/`.
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

No custom storage telemetry events (verified against `internal/storage/ls`).

## Notes

- Default path is `ss:///` (all buckets root) → remotePath `/`; recursive file paths
  then carry a leading slash, while an empty bucket is reported bare as `<bucket>/`.
- `--recursive`/`-r` walks the tree (BFS).
- `--local` / `--linked` are mutually exclusive; `--local` routes to the local stack,
  otherwise the linked project is used. They are declared **per-leaf** (not as
  `storage`-group scoped globals) because Effect CLI requires global-flag names to be
  unique tree-wide and `seed` already owns `linked`/`local`; the only behavioural cost
  vs Go's persistent flags is that they must follow the subcommand token
  (`storage ls --local`, not `storage --local ls`) — the same shape the `db` family uses.
