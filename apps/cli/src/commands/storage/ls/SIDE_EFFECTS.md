# `supabase storage ls [path]`

Lists objects/buckets by path prefix against the Storage gateway (local stack or linked project).

`--local` resolves the Storage gateway through the `experimental.stack`
feature flag, same `SUPABASE_EXPERIMENTAL_STACK=1|0` env precedence as
[`docs/stack-commands.md`](../../../../docs/stack-commands.md). `--linked`/`--project-ref`
targeting is unchanged under either backend; see Notes for the stack-backend endpoint,
credential, capability-state, and error behavior.

## Files Read

| Path                                          | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`              | TOML       | always (local creds/baseUrl; `[remotes.*]` merge when linked). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--project-ref`/`--linked`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                    | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `~/.supabase/<hash>/linked-project.json`      | JSON       | linked path, to resolve the project ref                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| local Kong TLS cert/key                       | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.env*`, `<workdir>/.env*` | dotenv     | local path: read on both backends for `env(VAR)` interpolation while loading `config.toml`; on the legacy backend also to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                                                                     |

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

| Variable                                                                                                                                                        | Purpose                                                                                                                                      | Required?                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY`                                                                                                                                | linked: bypass tenant key fetch (shell env only); local: explicit key, shell or project dotenv, `encrypted:` decrypted — legacy backend only | no                                   |
| `SUPABASE_AUTH_JWT_SECRET`                                                                                                                                      | local: derive service-role key, shell or project dotenv, `encrypted:` decrypted — legacy backend only                                        | no (→ `auth.jwt_secret` → default)   |
| `SUPABASE_ACCESS_TOKEN`                                                                                                                                         | linked: Management API auth                                                                                                                  | no (→ `~/.supabase/access-token`)    |
| `SUPABASE_PROJECT_ID`                                                                                                                                           | linked: project-ref resolution, superseded by `--project-ref` when set                                                                       | no                                   |
| `SUPABASE_SERVICES_HOSTNAME`                                                                                                                                    | local baseUrl host — legacy backend only                                                                                                     | no (→ Docker host → `127.0.0.1`)     |
| `SUPABASE_API_PORT`, `SUPABASE_API_EXTERNAL_URL`, `SUPABASE_API_TLS_ENABLED`, `SUPABASE_API_TLS_CERT_PATH`, `SUPABASE_API_TLS_KEY_PATH`, `SUPABASE_API_ENABLED` | local: override the matching `[api]` fields for the gateway URL/TLS, shell env or project dotenv (shell wins; #6452) — legacy backend only   | no                                   |
| `SUPABASE_EXPERIMENTAL_STACK`                                                                                                                                   | `1`/`0` selects the stack backend for `--local`, overriding `experimental.stack`                                                             | no (→ `experimental.stack` → legacy) |
| `SUPABASE_EXPERIMENTAL`                                                                                                                                         | experimental gate: `--experimental` equivalent                                                                                               | yes, unless `--experimental` given   |

`storage` is an experimental command: every subcommand requires
`--experimental` (or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                            |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                       |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                          |
| `1`  | invalid URL / url-parse error / API non-2xx / network / auth / config parse                                                                        |
| `1`  | `--project-ref` set with `--local` (see Notes)                                                                                                     |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                    |
| `1`  | stack backend: stack not registered/running, missing API endpoint or credentials, or the stack API is unavailable (`StackStorageUnavailableError`) |

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
- **Stack backend (`--local`).** The Storage endpoint is the selected stack's API
  gateway URL (`status.endpoints.api.url`) + `/storage/v1/...`; the credential is the
  stack's service-role JWT read from the stack's credentials. The stack is located by
  the project root (workdir realpath) via the `@supabase/stack` API, which reads stack
  state under `SUPABASE_HOME`. `ls` never creates a stack.
- **Stack backend — capability policy.** Storage `disabled` (e.g.
  `stack start -x storage`) errors with `StackStorageCapabilityError` ("Storage is
  disabled for this stack.") with guidance to enable `[storage]`, then run
  `supabase stack stop` followed by `supabase stack start` without `-x storage`;
  `failed`/`stopped` raises the same error class ("Storage failed to start for this
  stack"/"Storage is stopped for this stack."), with the capability error appended
  when present, and guidance to run `supabase stack restart`.
  `dormant`/`starting`/`ready`/`stopping` all proceed — the
  gateway activates a lazily-configured Storage on the first request and holds that
  request, and wakes a stopping Storage once its cleanup completes; there is no
  client-side polling. A stack that is not registered, not running, missing
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
