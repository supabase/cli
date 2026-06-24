# `supabase storage mv <src> <dst>`

Native TypeScript port of `apps/cli-go/internal/storage/mv`. Moves objects within a
bucket. Both paths must be `ss://` and resolve to the same bucket. A direct move that
returns `not_found` falls back to a recursive per-object move when `--recursive` is set.

## Files Read

| Path                                     | Format     | When                                                  |
| ---------------------------------------- | ---------- | ----------------------------------------------------- |
| `<workdir>/supabase/config.toml`         | TOML       | always (local creds; `[remotes.*]` merge when linked) |
| `~/.supabase/access-token`               | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset       |
| `~/.supabase/<hash>/linked-project.json` | JSON       | linked path, to resolve the project ref               |
| local Kong TLS cert/key                  | PEM        | local + `api.enabled` + `api.tls.enabled`             |

## Files Written

| Path                                     | Format | When                  |
| ---------------------------------------- | ------ | --------------------- |
| `~/.supabase/<hash>/linked-project.json` | JSON   | post-run, linked path |
| `~/.supabase/telemetry.json`             | JSON   | post-run (always)     |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body                                                 | Response         |
| ------ | ----------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `POST` | `/storage/v1/object/move`                 | `{bucketId, sourceKey, destinationKey}`                      | `{message}`      |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive fallback) | `[{name, id?}]`  |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (linked, Management API)                                   | service-role key |

## Environment Variables

`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_SERVICES_HOSTNAME` — same roles as `storage ls`.

`storage` is an experimental command (Go `root.go:63`): `mv` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                              |
| `1`  | invalid/parse url, missing object path (both roots), cross-bucket move, object-not-found (recursive empty), API non-2xx, network, auth, config parse |

## Output

### `--output-format text` (Go CLI compatible)

- `Moving object: <src> => <dst>` (stderr) for the top-level move and each recursive move.
- The move response `message` is printed (stderr) on a successful single move.

### `--output-format json`

```json
{ "message": "Successfully moved" }
```

(Recursive fallback emits `{ "message": "", "moved": <count> }`.)

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"message":"Successfully moved"}}
```

## Telemetry Events Fired

| Event                  | When                                       | Notable properties               |
| ---------------------- | ------------------------------------------ | -------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/linked/local) |

## Notes

- Both `src` and `dst` must be `ss://` URLs (Go uses `ParseStorageURL`, not the lenient
  `url.Parse` that `cp` uses).
- The cross-bucket and missing-path checks run before any network call.
- `--recursive`/`-r` only takes effect when the direct move returns `"error":"not_found"`.
