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

| Path                                           | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always (local creds; `[remotes.*]` merge when linked). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--project-ref`/`--linked`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                     | plain text | linked path, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<workdir>/supabase/.temp/project-ref`         | plain text | linked path, when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | linked path, existence check before the cache fill                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| local Kong TLS cert/key                        | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | local path: read on both backends for `env(VAR)` interpolation while loading `config.toml`; on the legacy backend also to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                                                             |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                  |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | post-run, linked path (`--local` false) — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run (always)                                                                                                                                                                     |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body                                                                                                                                                                                                                    | Response                                              |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST` | `/storage/v1/object/move`                 | `{bucketId, sourceKey, destinationKey}`                                                                                                                                                                                         | `{message}`                                           |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive fallback)                                                                                                                                                                    | `[{name, id?}]`                                       |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (linked, Management API; skipped when `SUPABASE_AUTH_SERVICE_ROLE_KEY` is set to a non-empty value in the shell env)                                                                                                          | service-role key                                      |
| `GET`  | `/v1/projects/{ref}`                      | — (linked, Management API; best-effort cache fill after the ref resolves, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored) | `ref`, `name`, `organization_id`, `organization_slug` |

## Environment Variables

`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICES_HOSTNAME`, and the `SUPABASE_API_*`
override family are legacy backend only. `SUPABASE_AUTH_SERVICE_ROLE_KEY` is legacy backend only
for `--local`; on the linked path a non-empty shell value skips the api-keys call under either
backend. `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, and `SUPABASE_EXPERIMENTAL_STACK` (backend selection) apply to either
backend — same roles as `storage ls`.
`SUPABASE_PROJECT_ID`'s linked-ref resolution is superseded by `--project-ref` when set.

`storage` is an experimental command: `mv` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Target selection

With no `--local` or `--linked` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then `supabase/.env*`), then `target` in `supabase/config.toml` (or
`config.json`). `remote` targets the linked project through the existing linked path; `local`
targets the local stack. An explicit selector flag always wins over the target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid
`SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config is only read for
the target when no selector flag is given; an unreadable config counts as unset. The target is resolved once in the command wrapper (after the experimental gate and the `--linked`/`--local` mutex check) and passed to the handler as the effective `--local` value.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, `supabase/.env`, `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

When neither is set the command keeps targeting the linked project and writes one warning to
**stderr** (every `--output-format`, never stdout), so scripts depending on today's default keep
working while the next major version moves it to the local stack:

```
Warning: supabase storage mv will target the local stack by default in the next major version. Pass --linked, or set target = "remote" in your Supabase config (or SUPABASE_TARGET=remote), to keep targeting the linked project.
```

No warning is written when a selector flag, `--project-ref`, `SUPABASE_TARGET` or `target` is set.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                     |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                                                                                                |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                                                                                                   |
| `1`  | invalid/parse url, missing object path (both roots), cross-bucket move, object-not-found (recursive empty), API non-2xx, network, auth, config parse                                                                        |
| `1`  | `--project-ref` set with `--local` (see Notes)                                                                                                                                                                              |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                             |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`) |

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
- **`--local=false`** / `--no-local` target the linked project: routing follows the parsed
  `--local` value, and `--linked` is not read for routing.
- Both `src` and `dst` must be `ss://` URLs (a stricter parse than the lenient one
  `cp` uses).
- **Stack backend (`--local`).** The Storage endpoint comes from the selected composition's
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
