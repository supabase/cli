# `supabase storage mv <src> <dst>`

Target: selectable, consent default No — see [Command target](../../../../docs/command-target.md)

Moves objects within a bucket. Both paths must be `ss://` and resolve to the same bucket.
A direct move that returns `not_found` falls back to a recursive per-object move when
`--recursive` is set.

The local Storage gateway
resolves through the `experimental.stack` feature flag, same `SUPABASE_EXPERIMENTAL_STACK=1|0` env
precedence as [`docs/stack-commands.md`](../../../../docs/stack-commands.md); see Notes for the
stack-backend endpoint, credential, capability-state, and error behavior.

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always (local creds; `[remotes.*]` merge when linked). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--remote`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                     | plain text | remote project or branch lookup, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | the `Target:` banner and the linked-checkout hint, the parent project for `--remote=<branch>`, and the existence check before the cache fill                                                                                                                                                                                                                                                                                                                                            |
| local Kong TLS cert/key                        | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | local path: read on both backends for `env(VAR)` interpolation while loading `config.toml`; on the legacy backend also to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                                             |

## Files Written

| Path                                           | Format | When                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | post-run, remote project — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run (always)                                                                                                                                                      |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body                                                                                                                                                                                                                            | Response                                              |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST` | `/storage/v1/object/move`                 | `{bucketId, sourceKey, destinationKey}`                                                                                                                                                                                                 | `{message}`                                           |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive fallback)                                                                                                                                                                            | `[{name, id?}]`                                       |
| `GET`  | `/v1/projects`                            | — (Management API; project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format)                                                              | `[{id, name, organization_slug, region}]`             |
| `GET`  | `/v1/projects/{parent}/branches`          | — (Management API; only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project)      | `[{id, name, project_ref, is_default}]`               |
| `GET`  | `/v1/branches/{id}`                       | — (Management API; only for `--remote=<branch UUID>` when no project is linked)                                                                                                                                                         | `{ref, status, …}`                                    |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (remote project, Management API; skipped when `SUPABASE_AUTH_SERVICE_ROLE_KEY` is set to a non-empty value in the shell env)                                                                                                          | service-role key                                      |
| `GET`  | `/v1/projects/{ref}`                      | — (remote project, Management API; best-effort cache fill after the ref resolves, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored) | `ref`, `name`, `organization_id`, `organization_slug` |

## Environment Variables

`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICES_HOSTNAME`, and the `SUPABASE_API_*`
override family are legacy backend only. `SUPABASE_AUTH_SERVICE_ROLE_KEY` is legacy backend only
for the local target; on a remote project a non-empty shell value skips the api-keys call under either
backend. `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, and `SUPABASE_EXPERIMENTAL_STACK` (backend selection) apply to either
backend — same roles as `storage ls`.
`SUPABASE_PROJECT_ID` supplies the ref for a bare `--remote` and the parent project for `--remote=<branch>`.

`storage` is an experimental command: `mv` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                            |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                                                                                                       |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                                                                                                          |
| `1`  | invalid/parse url, missing object path (both roots), cross-bucket move, object-not-found (recursive empty), API non-2xx, network, auth, config parse                                                                               |
| `1`  | move on a remote project without consent: a JSON, piped or non-interactive run without `--yes`/shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`), or a declined prompt (`HostedMutationDeclinedError`) — nothing is sent |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                                    |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`)        |

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

| Event                  | When                                       | Notable properties                      |
| ---------------------- | ------------------------------------------ | --------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/remote/linked/local) |

## Notes

- **Target banner.** A remote project prints its `Target:` line to stderr once its ref resolves; the local
  target prints it once the Storage endpoint is known. Both come before the first Storage request.
- **Hosted consent.** Moving on a remote project asks once, after the path validation and before any
  Storage request: `Move <src> to <dst>?`, default No; a recursive move adds a line saying every
  object under the source path is moved. Declining exits 1 with
  `HostedMutationDeclinedError` (`context canceled`); no Storage request is sent.
  A move on the local stack never asks.
- Both `src` and `dst` must be `ss://` URLs (a stricter parse than the lenient one
  `cp` uses).
- **Stack backend (local target).** The Storage endpoint comes from the selected composition's
  Storage member observation, and the service-role JWT is generated from the primary database's
  observed JWT secret. The stack is opened by project identity through the `@supabase/stack` API,
  which reads stack state under `SUPABASE_HOME`; `mv` opens saved state without launching
  the owner or any service member.
- **Stack backend — capability policy.** Storage excluded from the composition errors with
  `StackStorageCapabilityError` and guidance to enable `[storage]`, then run `supabase start`
  without `--exclude storage`. Failed or manually stopped Storage is unusable. Dormant, starting, and ready Storage
  proceed; stopping Storage proceeds only when idle shutdown retains wake-up. The gateway
  wakes lazy members on the first request. The primary database must be running and healthy
  before Storage requests are attempted. A stack that is
  not registered, has no primary database composition member, is not ready, or has no Storage
  HTTP endpoint errors with `StackStorageUnavailableError` or `StackStorageCapabilityError`.
  A stack-gateway 502/503 during Storage activation is reported as `StackStorageCapabilityError`
  with guidance to inspect logs and restart; linked failures pass through unchanged. No HTTP
  request is sent when Storage is disabled or the primary database is not ready.
- **Secrets.** The stack's service-role JWT is never printed or logged; error messages
  contain only lifecycle/capability state text.
- The cross-bucket and missing-path checks run before any network call.
- `--recursive`/`-r` only takes effect when the direct move returns `"error":"not_found"`.
