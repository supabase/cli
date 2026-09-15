# `supabase storage mv <src> <dst>`

Moves objects within a bucket. Both paths must be `ss://` and resolve to the same bucket.
A direct move that returns `not_found` falls back to a recursive per-object move when
`--recursive` is set.

`--local` resolves the Storage gateway through the `experimental.stack`
feature flag, same `SUPABASE_EXPERIMENTAL_STACK=1|0` env precedence as
[`docs/stack-commands.md`](../../../../docs/stack-commands.md). `--linked`/`--project-ref`
targeting is unchanged under either backend; see Notes for the stack-backend endpoint,
credential, capability-state, and error behavior.

## Files Read

| Path                                          | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`              | TOML       | always (local creds; `[remotes.*]` merge when linked). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--project-ref`/`--linked`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                    | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `~/.supabase/<hash>/linked-project.json`      | JSON       | linked path, to resolve the project ref                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| local Kong TLS cert/key                       | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.env*`, `<workdir>/.env*` | dotenv     | local path, to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key — legacy backend only                                                                                                                                                                                                                                                                                                                  |

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

`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICES_HOSTNAME`,
and the `SUPABASE_API_*` override family are legacy backend only; `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, and `SUPABASE_EXPERIMENTAL_STACK` (backend selection) apply to either
backend — same roles as `storage ls`.
`SUPABASE_PROJECT_ID`'s linked-ref resolution is superseded by `--project-ref` when set.

`storage` is an experimental command: `mv` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                              |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                         |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                            |
| `1`  | invalid/parse url, missing object path (both roots), cross-bucket move, object-not-found (recursive empty), API non-2xx, network, auth, config parse |
| `1`  | `--project-ref` set with `--local` (see Notes)                                                                                                       |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                      |
| `1`  | stack backend: stack not registered/running, missing API endpoint or credentials, or the stack API is unavailable (`StackStorageUnavailableError`)   |

## Output

### `--output-format text`

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

- **`--project-ref`** (TS-only, no Go equivalent) overrides ONLY the linked-ref
  resolution used above (flag > `SUPABASE_PROJECT_ID` > `.temp/project-ref`).
  It never implies `--linked`: passing it with `--local` is a hard error
  rather than a silently discarded flag.
- Both `src` and `dst` must be `ss://` URLs (a stricter parse than the lenient one
  `cp` uses).
- **Stack backend (`--local`).** The Storage endpoint is the selected stack's API
  gateway URL (`status.endpoints.api.url`) + `/storage/v1/...`; the credential is the
  stack's service-role JWT read from the stack's credentials. The stack is located by
  the project root (workdir realpath) via the `@supabase/stack` API, which reads stack
  state under `SUPABASE_HOME`. `mv` never creates a stack.
- **Stack backend — capability policy.** Storage `disabled` (e.g. `stack start -x
storage`) errors with `StackStorageCapabilityError` ("Storage is disabled for this
  stack.") with guidance to set `[storage] enabled = true` or start without `-x
storage`, then run `supabase stack restart`; `failed`/`stopped` raises the same error
  class ("Storage failed to start for this stack"/"Storage is stopped for this
  stack."), with the capability error appended when present, and guidance to run
  `supabase stack restart`. `dormant`/`starting`/`ready` all proceed — the gateway
  activates a lazily-configured Storage on the first request and holds that request;
  there is no client-side polling. A stack that is not registered, not running, missing
  its API endpoint or credentials, or whose stack API is unavailable errors with
  `StackStorageUnavailableError` and guidance to run `supabase stack status` or
  `supabase stack restart` (or `supabase start` when the stack was never configured). A
  stack-gateway 502/503 during Storage activation is reported as
  `StackStorageCapabilityError` with guidance to run `supabase stack logs` then
  `supabase stack restart`, instead of a raw status body — for a `--local` target only;
  a `--linked` failure passes through unchanged. No HTTP request is sent when Storage is
  disabled or the stack is not running.
- **Secrets.** The stack's service-role JWT is never printed or logged; error messages
  contain only lifecycle/capability state text.
- The cross-bucket and missing-path checks run before any network call.
- `--recursive`/`-r` only takes effect when the direct move returns `"error":"not_found"`.
