# `supabase storage cp <src> <dst>`

Copies objects between local paths and the Storage service. The scheme of `src`/`dst` selects the operation:
`ss://`→local download, local→`ss://` upload, both `ss://` → error, both local → unsupported.

With no selector the command targets the local stack. `--remote` targets the linked project,
`--remote=<ref>` another project and `--remote=<branch>` a branch of the linked project (see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md));
`--local`, `--linked` and `--project-ref` are deprecated aliases. The local Storage gateway
resolves through the `experimental.stack` feature flag, same `SUPABASE_EXPERIMENTAL_STACK=1|0` env
precedence as [`docs/stack-commands.md`](../../../../docs/stack-commands.md); see Notes for the
stack-backend endpoint, credential, capability-state, and error behavior.

## Files Read

| Path                                           | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`               | TOML       | always (local creds; `[storage.buckets.*]` for bucket auto-create). With an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target, a missing project config is now a hard failure (`StorageMissingProjectConfigError`) rather than a fall-back to embedded defaults — the default `api.port` would otherwise point the operation at a different local stack; a REMOTE (`--remote`) target never hard-fails on this, since credential resolution there reads the Management API, not local config |
| `~/.supabase/access-token`                     | plain text | remote project or branch lookup, when `SUPABASE_ACCESS_TOKEN` unset                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<workdir>/supabase/.temp/project-ref`         | plain text | a remote project: resolves the ref (bare `--remote` with no `SUPABASE_PROJECT_ID`) and tells whether it is the linked project; with no selector, only to word the linked-checkout hint                                                                                                                                                                                                                                                                                                               |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | the `Target:` banner and the linked-checkout hint, the parent project for `--remote=<branch>`, and the existence check before the cache fill                                                                                                                                                                                                                                                                                                                                                         |
| local Kong TLS cert/key                        | PEM        | legacy backend only, local + `api.enabled` + `api.tls.enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | local path: read on both backends for `env(VAR)` interpolation while loading `config.toml`; on the legacy backend also to resolve the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                                                                          |
| upload source files                            | bytes      | upload: sniff (≤512 bytes) + streamed body                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Files Written

| Path                                           | Format | When                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| download destination files                     | bytes  | download (single: O_EXCL `wx`; recursive: O_TRUNC `w`)                                                                                                                 |
| download destination parent dirs               | dir    | recursive download (`mkdir -p`)                                                                                                                                        |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | post-run, remote project — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run (always)                                                                                                                                                      |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method | Path                                      | Request body / headers                                                                                                                                                                                                                  | Response                                              |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/storage/v1/object/{path}`               | — (download)                                                                                                                                                                                                                            | binary stream                                         |
| `POST` | `/storage/v1/object/{path}`               | file stream; `Content-Type`, `Cache-Control`, `x-upsert` (recursive only)                                                                                                                                                               | —                                                     |
| `POST` | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive walk + dst detection)                                                                                                                                                                | `[{name, id?}]`                                       |
| `GET`  | `/storage/v1/bucket`                      | — (recursive walk to bucket root)                                                                                                                                                                                                       | `[{name, id}]`                                        |
| `POST` | `/storage/v1/bucket`                      | `{name, public?, file_size_limit?, allowed_mime_types?}` (auto-create on 404)                                                                                                                                                           | `{name}`                                              |
| `GET`  | `/v1/projects`                            | — (Management API; project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format)                                                              | `[{id, name, organization_slug, region}]`             |
| `GET`  | `/v1/projects/{parent}/branches`          | — (Management API; only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project)      | `[{id, name, project_ref, is_default}]`               |
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

`storage` is an experimental command: `cp` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                 |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard                                                                                                                            |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`)                                                                                                                               |
| `1`  | invalid/parse url, unsupported operation (local→local), copy-between-buckets, object-not-found (recursive download), file create/read failure, API non-2xx, network, auth, config parse                                                                 |
| `1`  | two of `--remote`, `--linked` and `--local`, or `--project-ref` with `--local` or `--remote=<value>` (`TargetSelectorConflictError`, `TargetProjectRefConflictError`), after the experimental gate and the workdir check and before any Storage request |
| `1`  | `--remote=<db-url>` (`TargetNeedsProjectError`): the Storage API needs a project, not a database URL; no Storage request is sent                                                                                                                        |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist)                                                                                                                                  |
| `1`  | upload to a remote project without consent: a JSON, piped or non-interactive run without `--yes`/shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`), or a declined prompt (`HostedMutationDeclinedError`) — nothing is sent                    |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                                                         |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`)                             |

## Output

### `--output-format text`

- Recursive download prints `Downloading: <remote> => <local>` per object (stderr).
- Recursive upload prints `Uploading: <local> => <remote>` per file (stderr).
- Single copies are silent.
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

| Event                  | When                                       | Notable properties                                                                                   |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/cache-control/content-type/jobs/remote/linked/local; non-boolean values redacted) |

## Notes

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
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase storage cp --remote`
  and `--local isn't needed (local is the default) and will be removed in v4: supabase storage cp`.
  Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local` or `--remote=<value>`, an empty `--project-ref` is rejected, and
  `--linked=false` selects nothing.
- **Target banner.** A remote project prints `Target: …` to stderr once its ref resolves; the local
  target prints `Target: local stack (<host>:<port>)` once the Storage endpoint is known. Both come
  before the first Storage request.
- **Hosted consent.** Uploading to a remote project asks once, before any Storage request:
  `Upload <src> to <dst>?`, default No; a recursive upload adds a line saying existing objects
  under the destination are overwritten. `--yes` or a shell `SUPABASE_YES` grants it and echoes
  `Confirmed by --yes: …` to stderr; otherwise only an interactive text-mode terminal is asked, and
  JSON, piped, agent and non-TTY runs exit 1 with `HostedMutationConsentRequiredError`.
  A piped answer on stdin and a `SUPABASE_YES` in `supabase/.env` do not count. Declining exits 1 with
  `HostedMutationDeclinedError` (`context canceled`); no Storage request is sent.
  Downloads and uploads to the local stack never ask.
- Single upload does NOT send `x-upsert`; recursive upload sets it.
- `--content-type` overrides the sniffed type; an explicit value is still refined when
  it is a generic `text/plain`.
- `--cache-control` defaults to `max-age=3600`; an empty value resets to that default.
- `--jobs`/`-j` bounds upload/download concurrency (default 1).
- The runtime default for `--content-type` is `""` (empty ⇒ auto-detect).
- Relative local paths resolve against the original cwd.
- **Stack backend (local target).** The Storage endpoint comes from the selected composition's
  Storage member observation, and the service-role JWT is generated from the primary database's
  observed JWT secret. The stack is opened by project identity through the `@supabase/stack` API,
  which reads stack state under `SUPABASE_HOME`; `cp` opens saved state without launching
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
- **Recursive download path traversal (accepted risk).** Recursive download writes
  to `path.join(localPath, relPath)` where `relPath` is derived from the
  server-returned object name. `path.join` normalizes `..`, so a hostile or
  compromised endpoint returning a name like `../../../etc/...` can resolve a
  write **outside** `localPath` — parent dirs are `mkdir -p`'d and files open
  `O_TRUNC`, making it a write/overwrite primitive. This is intentionally
  **not** guarded. Blast radius is gated behind `--experimental` + `cp -r` +
  remote→local + a hostile endpoint. `downloadSingle` is unaffected (user-supplied
  path, `O_EXCL` `wx`).
