# `supabase storage rm <file> ...`

Removes objects by path. Paths are grouped by bucket; each bucket is confirmed, its explicit prefixes are deleted
(chunked at 1000), and any prefix that resolved to a directory is removed recursively
when `-r` is set. With no paths and `-r`, every bucket is cleared and deleted.

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
| `<workdir>/supabase/.env*`, `<workdir>/.env*` | dotenv     | always, to resolve `SUPABASE_YES` (CLI-1878) and, on both backends, for `env(VAR)` interpolation while loading `config.toml`; on the local, legacy-backend path also the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                          |

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

`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICES_HOSTNAME`,
and the `SUPABASE_API_*` override family are legacy backend only; `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_EXPERIMENTAL_STACK` (backend selection), and `SUPABASE_YES`
(auto-confirm) apply to either backend —
read from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files
(shell wins; CLI-1878).
`SUPABASE_PROJECT_ID`'s linked-ref resolution is superseded by `--project-ref` when set.

`storage` is an experimental command: `rm` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including a confirmation declined at the text-mode prompt, and a tolerated `Bucket not found`)                                                                                                                                                               |
| `1`  | any resolved non-text output mode without `--yes`/`SUPABASE_YES` (`StorageRmConfirmationRequiredError`) — there is no prompt to ask on, so nothing is deleted and no Storage request is sent (a run with no paths and no `-r` reports the missing-`-r` failure first) |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard, including any `DELETE` call                                                                                                             |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`) — also beats any `DELETE` call                                                                                                              |
| `1`  | invalid/parse url, missing bucket (root path), missing `-r` flag (directory or no args), object-not-found (recursive empty prefix), API non-2xx, network, auth, config parse                                                                                          |
| `1`  | `--project-ref` set with `--local` (see Notes)                                                                                                                                                                                                                        |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                                                                       |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`)                                           |

## Output

### `--output-format text`

- `Confirm deleting files in bucket <bold bucket>?` prompt (default no); `--yes`/`SUPABASE_YES`
  echoes `<label> [y/N] y` and proceeds.
- `Deleting objects: [<space-separated prefixes>]` per delete batch (stderr).
- `Object not found: <prefix>` (non-recursive) / `Deleting bucket: <bucket>` /
  `Bucket not found: <bucket>` (stderr).

### `--output-format json`

Requires `--yes`/`SUPABASE_YES`; without it the run fails before any Storage request rather
than defaulting the unaskable confirmation to no and reporting an empty deletion. This
applies to the resolved output mode, so it also covers the JSON a detected or
`--agent yes` coding agent selects when neither `--output-format` nor `-o`/`--output` is given.

```json
{ "deleted": ["abstract.pdf"], "buckets_deleted": ["private"] }
```

### `--output-format stream-json`

Requires `--yes`/`SUPABASE_YES` on the same terms as `json`.

```ndjson
{"type":"result","data":{"deleted":["abstract.pdf"],"buckets_deleted":["private"]}}
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
- Validation (missing bucket, missing `-r` for a directory) runs before any network call;
  the no-args missing-`-r` error runs after the client is built, and keeps beating the
  confirmation refusal in every output mode.
- A confirmation declined at the text-mode prompt skips that bucket and is not an error;
  a resolved non-text output mode has no prompt to decline, so it hard-fails without
  `--yes` instead (`StorageRmConfirmationRequiredError`), before the Storage gateway is
  contacted. "Resolved" covers `--output-format json|stream-json` and agent-selected JSON
  alike; `-o`/`--output` does not select an output format for `rm` (it stays text), so `rm`
  keeps the text prompt and its piped-answer handling, and an explicit `-o` also opts out of
  the agent JSON default.
- Explicit deletes are attempted first ("in case the paths resolve to extensionless files");
  prefixes not returned as removed are then walked recursively when `-r` is set.
- Object deletes are chunked at `DELETE_OBJECTS_LIMIT` (1000) per request.
- **Stack backend (`--local`).** The Storage endpoint comes from the selected composition's
  Storage member observation, and the service-role JWT is generated from the primary database's
  observed JWT secret. The stack is opened by project identity through the `@supabase/stack` API,
  which reads stack state under `SUPABASE_HOME`; `rm` opens saved state without launching
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
