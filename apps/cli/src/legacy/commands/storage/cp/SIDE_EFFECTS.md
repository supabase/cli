# `supabase storage cp <src> <dst>`

Native TypeScript port of `apps/cli-go/internal/storage/cp`. Copies objects between
local paths and the Storage service. The scheme of `src`/`dst` selects the operation:
`ss://`→local download, local→`ss://` upload, both `ss://` → error, both local → unsupported.

## Files Read

| Path                                     | Format     | When                                                               |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`         | TOML       | always (local creds; `[storage.buckets.*]` for bucket auto-create) |
| `~/.supabase/access-token`               | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                    |
| `~/.supabase/<hash>/linked-project.json` | JSON       | linked path, to resolve the project ref                            |
| local Kong TLS cert/key                  | PEM        | local + `api.enabled` + `api.tls.enabled`                          |
| upload source files                      | bytes      | upload: sniff (≤512 bytes) + streamed body                         |

## Files Written

| Path                                     | Format | When                                                   |
| ---------------------------------------- | ------ | ------------------------------------------------------ |
| download destination files               | bytes  | download (single: O_EXCL `wx`; recursive: O_TRUNC `w`) |
| download destination parent dirs         | dir    | recursive download (`mkdir -p`)                        |
| `~/.supabase/<hash>/linked-project.json` | JSON   | post-run, linked path                                  |
| `~/.supabase/telemetry.json`             | JSON   | post-run (always)                                      |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body / headers                                                        | Response         |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| `GET`  | `/storage/v1/object/{path}`               | — (download)                                                                  | binary stream    |
| `POST` | `/storage/v1/object/{path}`               | file stream; `Content-Type`, `Cache-Control`, `x-upsert` (recursive only)     | —                |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive walk + dst detection)      | `[{name, id?}]`  |
| `GET`  | `/storage/v1/bucket`                      | — (recursive walk to bucket root)                                             | `[{name, id}]`   |
| `POST` | `/storage/v1/bucket`                      | `{name, public?, file_size_limit?, allowed_mime_types?}` (auto-create on 404) | `{name}`         |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (linked, Management API)                                                    | service-role key |

## Environment Variables

`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_SERVICES_HOSTNAME` — same roles as `storage ls`.

## Exit Codes

| Code | Condition                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                 |
| `1`  | invalid/parse url, unsupported operation (local→local), copy-between-buckets, object-not-found (recursive download), file create/read failure, API non-2xx, network, auth, config parse |

## Output

### `--output-format text` (Go CLI compatible)

- Recursive download prints `Downloading: <remote> => <local>` per object (stderr).
- Recursive upload prints `Uploading: <local> => <remote>` per file (stderr).
- Single copies are silent (Go's `api.{Download,Upload}Object`).
- Empty recursive download → `Object not found: <remote>`.

### `--output-format json`

```json
{ "uploaded": [{ "from": "…", "to": "…" }], "downloaded": [{ "from": "…", "to": "…" }] }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"uploaded":[…],"downloaded":[…]}}
```

## Telemetry Events Fired

| Event                  | When                                       | Notable properties                                                                            |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/cache-control/content-type/jobs/linked/local; non-boolean values redacted) |

## Notes

- Single upload does NOT send `x-upsert`; recursive upload sets it (Go's `Overwrite`).
- `--content-type` overrides the sniffed type; an explicit value is still refined when
  it is a generic `text/plain` (Go's `ParseFileOptions` → `UploadObject`).
- `--cache-control` defaults to `max-age=3600`; an empty value resets to that default.
- `--jobs`/`-j` bounds upload/download concurrency (default 1).
- DQ-1: Go help shows `--content-type` DefValue `auto-detect`; the runtime default is
  `""` (empty ⇒ auto-detect). Effect renders the real `""` (cosmetic help diff only).
- Relative local paths resolve against the original cwd (Go's `utils.CurrentDirAbs`).
