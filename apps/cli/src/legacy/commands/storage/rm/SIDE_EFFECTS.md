# `supabase storage rm <file> ...`

Native TypeScript port of `apps/cli-go/internal/storage/rm`. Removes objects by path.
Paths are grouped by bucket; each bucket is confirmed, its explicit prefixes are deleted
(chunked at 1000), and any prefix that resolved to a directory is removed recursively
when `-r` is set. With no paths and `-r`, every bucket is cleared and deleted.

## Files Read

| Path                                          | Format     | When                                                               |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`              | TOML       | always (local creds; `[remotes.*]` merge when linked)              |
| `~/.supabase/access-token`                    | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                    |
| `~/.supabase/<hash>/linked-project.json`      | JSON       | linked path, to resolve the project ref                            |
| local Kong TLS cert/key                       | PEM        | local + `api.enabled` + `api.tls.enabled`                          |
| `<workdir>/supabase/.env*`, `<workdir>/.env*` | dotenv     | always, to resolve `SUPABASE_YES` (CLI-1878; Go's `loadNestedEnv`) |

## Files Written

| Path                                     | Format | When                  |
| ---------------------------------------- | ------ | --------------------- |
| `~/.supabase/<hash>/linked-project.json` | JSON   | post-run, linked path |
| `~/.supabase/telemetry.json`             | JSON   | post-run (always)     |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method   | Path                                      | Request body                                             | Response         |
| -------- | ----------------------------------------- | -------------------------------------------------------- | ---------------- |
| `DELETE` | `/storage/v1/object/{bucket}`             | `{prefixes}` (chunked by 1000)                           | `[{name, ...}]`  |
| `DELETE` | `/storage/v1/bucket/{id}`                 | — (recursive on an empty prefix)                         | `{message}`      |
| `POST`   | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive walk) | `[{name, id?}]`  |
| `GET`    | `/storage/v1/bucket`                      | — (no-args + `-r`: delete all buckets)                   | `[{name, id}]`   |
| `GET`    | `/v1/projects/{ref}/api-keys?reveal=true` | — (linked, Management API)                               | service-role key |

## Environment Variables

`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_SERVICES_HOSTNAME`, plus `SUPABASE_YES` (auto-confirm) —
read from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files
(shell wins; CLI-1878, matching Go's `loadNestedEnv` before `viper.GetBool("YES")`).

`storage` is an experimental command (Go `root.go:63`): `rm` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including a declined confirmation, and a tolerated `Bucket not found`)                                                                                              |
| `1`  | invalid/parse url, missing bucket (root path), missing `-r` flag (directory or no args), object-not-found (recursive empty prefix), API non-2xx, network, auth, config parse |

## Output

### `--output-format text` (Go CLI compatible)

- `Confirm deleting files in bucket <bold bucket>?` prompt (default no); `--yes`/`SUPABASE_YES`
  echoes `<label> [y/N] y` and proceeds.
- `Deleting objects: [<space-separated prefixes>]` (Go slice repr) per delete batch (stderr).
- `Object not found: <prefix>` (non-recursive) / `Deleting bucket: <bucket>` /
  `Bucket not found: <bucket>` (stderr).

### `--output-format json`

```json
{ "deleted": ["abstract.pdf"], "buckets_deleted": ["private"] }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"deleted":["abstract.pdf"],"buckets_deleted":["private"]}}
```

## Telemetry Events Fired

| Event                  | When                                       | Notable properties               |
| ---------------------- | ------------------------------------------ | -------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/linked/local) |

## Notes

- Validation (missing bucket, missing `-r` for a directory) runs before any network call;
  the no-args missing-`-r` error runs after the client is built (matching Go).
- A declined confirmation skips that bucket and is not an error.
- Explicit deletes are attempted first ("in case the paths resolve to extensionless files");
  prefixes not returned as removed are then walked recursively when `-r` is set.
- Object deletes are chunked at `DELETE_OBJECTS_LIMIT` (1000) per request.
