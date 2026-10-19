# `supabase storage ls [path]`

Lists objects/buckets by path prefix against the Storage gateway (local stack or a remote project).

With no selector the command targets the local stack. `--remote` targets the linked project,
`--remote=<ref>` another project and `--remote=<branch>` a branch of the linked project (see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md));
`--local`, `--linked` and `--project-ref` are deprecated aliases. The local Storage gateway
resolves through the `experimental.stack` feature flag, same `SUPABASE_EXPERIMENTAL_STACK=1|0` env
precedence as [`docs/stack-commands.md`](../../../../docs/stack-commands.md); see Notes for the
stack-backend endpoint, credential, capability-state, and error behavior.

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always (local creds/baseUrl; `[remotes.*]` merge when linked). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--project-ref`/`--linked`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                     | plain text | remote project or branch lookup, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint                                                                                                                                                                                                                                                                                                                          |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | the `Target:` banner and the linked-checkout hint, the parent project for `--remote=<branch>`, and the existence check before the cache fill                                                                                                                                                                                                                                                                                                                                                                    |
| local Kong TLS cert/key                        | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | local path: read on both backends for `env(VAR)` interpolation while loading `config.toml`; on the legacy backend also to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                                                                     |

## Files Written

| Path                                           | Format | When                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | post-run, remote project — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run (always)                                                                                                                                                      |

## API Routes

Auth: `apikey` header always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body                                                                                                                                                                                                                            | Response (used)                                       |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}`                                                                                                                                                                                                 | `[{name, id?}]` (id null ⇒ dir)                       |
| `GET`  | `/storage/v1/bucket`                      | —                                                                                                                                                                                                                                       | `[{name, id}]`                                        |
| `GET`  | `/v1/projects`                            | — (Management API; project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format)                                                              | `[{id, name, organization_slug, region}]`             |
| `GET`  | `/v1/projects/{parent}/branches`          | — (Management API; only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project)      | `[{id, name, project_ref, is_default}]`               |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true` | — (remote project, Management API; skipped when `SUPABASE_AUTH_SERVICE_ROLE_KEY` is set to a non-empty value in the shell env)                                                                                                          | api-key list → service-role key                       |
| `GET`  | `/v1/projects/{ref}`                      | — (remote project, Management API; best-effort cache fill after the ref resolves, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored) | `ref`, `name`, `organization_id`, `organization_slug` |

## Environment Variables

| Variable                                                                                                                                                        | Purpose                                                                                                                                              | Required?                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY`                                                                                                                                | remote project: bypass tenant key fetch (shell env only); local: explicit key, shell or project dotenv, `encrypted:` decrypted — legacy backend only | no                                   |
| `SUPABASE_AUTH_JWT_SECRET`                                                                                                                                      | local: derive service-role key, shell or project dotenv, `encrypted:` decrypted — legacy backend only                                                | no (→ `auth.jwt_secret` → default)   |
| `SUPABASE_ACCESS_TOKEN`                                                                                                                                         | remote project: Management API auth                                                                                                                  | no (→ `~/.supabase/access-token`)    |
| `SUPABASE_PROJECT_ID`                                                                                                                                           | remote project: ref for a bare `--remote`, and the parent project for `--remote=<branch>`                                                            | no                                   |
| `SUPABASE_SERVICES_HOSTNAME`                                                                                                                                    | local baseUrl host — legacy backend only                                                                                                             | no (→ Docker host → `127.0.0.1`)     |
| `SUPABASE_API_PORT`, `SUPABASE_API_EXTERNAL_URL`, `SUPABASE_API_TLS_ENABLED`, `SUPABASE_API_TLS_CERT_PATH`, `SUPABASE_API_TLS_KEY_PATH`, `SUPABASE_API_ENABLED` | local: override the matching `[api]` fields for the gateway URL/TLS, shell env or project dotenv (shell wins; #6452) — legacy backend only           | no                                   |
| `SUPABASE_EXPERIMENTAL_STACK`                                                                                                                                   | `1`/`0` selects the stack backend for the local target, overriding `experimental.stack`                                                              | no (→ `experimental.stack` → legacy) |
| `SUPABASE_EXPERIMENTAL`                                                                                                                                         | experimental gate: `--experimental` equivalent                                                                                                       | yes, unless `--experimental` given   |

`storage` is an experimental command: every subcommand requires
`--experimental` (or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                 |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                                                                                                                            |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                                                                                                                               |
| `1`  | invalid URL / url-parse error / API non-2xx / network / auth / config parse                                                                                                                                                                             |
| `1`  | two of `--remote`, `--linked` and `--local`, or `--project-ref` with `--local` or `--remote=<value>` (`TargetSelectorConflictError`, `TargetProjectRefConflictError`), after the experimental gate and the workdir check and before any Storage request |
| `1`  | `--remote=<db-url>` (`TargetNeedsProjectError`): the Storage API needs a project, not a database URL; no Storage request is sent                                                                                                                        |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist)                                                                                                                                  |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                                                         |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`)                             |

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

| Event                  | When                                       | Notable properties                      |
| ---------------------- | ------------------------------------------ | --------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/remote/linked/local) |

No custom storage telemetry events.

## Notes

- Default path is `ss:///` (all buckets root) → remotePath `/`; recursive file paths
  then carry a leading slash, while an empty bucket is reported bare as `<bucket>/`.
- `--recursive`/`-r` walks the tree (BFS).
- **Target.** With no selector the command runs against the local stack; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), `true|yes|on|1` (the linked project), or
  otherwise the name of a branch of the linked project, which resolves to that branch's own project.
  A database URL (`--remote=<db-url>`) fails with a `needs a project, not a database URL` error and
  sends no request. `false|no|off|0`, `--no-remote` and an empty value fail with
  `Leave out --remote to target the local Storage API.` A bare `--remote` followed by a word that is
  a branch of the linked project fails with a `Did you mean --remote=<word>?` hint, since the word
  may have been meant as the flag's value. The resolved target is announced on stderr (`Target: …`)
  in every output format and, in JSON results, as a `target` object.
- **Deprecated selectors.** `--linked`, `--project-ref` and `--local` are hidden aliases that still
  select their target and print a warning on stderr naming the replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase storage ls --remote`
  and `--local isn't needed (local is the default) and will be removed in v4: supabase storage ls`.
  Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local` or `--remote=<value>`, an empty `--project-ref` is rejected, and
  `--linked=false` selects nothing.
- **Target banner.** A remote project prints `Target: …` to stderr once its ref resolves; the local
  target prints `Target: local stack (<host>:<port>)` once the Storage endpoint is known. Both come
  before the first Storage request.
- `--remote` and the deprecated `--local` and `--linked` are declared **per-leaf** (not as
  `storage`-group scoped globals) because Effect CLI requires global-flag names to be unique
  tree-wide and `seed` already owns them; the only behavioural cost is that they must follow the
  subcommand token (`storage ls --remote`, not `storage --remote ls`) — the same shape the `db`
  family uses.
- Listing is a read: it never asks for consent.
- **Stack backend (local target).** The Storage endpoint comes from the selected composition's
  Storage member observation, and the service-role JWT is generated from the primary database's
  observed JWT secret. The stack is opened by project identity through the `@supabase/stack` API,
  which reads stack state under `SUPABASE_HOME`; `ls` opens saved state without launching
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
