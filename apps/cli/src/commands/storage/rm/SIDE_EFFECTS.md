# `supabase storage rm <file> ...`

Removes objects by path. Paths are grouped by bucket; its explicit prefixes are deleted
(chunked at 1000), and any prefix that resolved to a directory is removed recursively
when `-r` is set. With no paths and `-r`, every bucket is cleared and deleted. The local stack
confirms each bucket; a remote project asks once for the whole run.

With no selector the command targets the local stack. `--remote` targets the linked project,
`--remote=<ref>` another project and `--remote=<branch>` a branch of the linked project (see
[ADR 0033](../../../../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md));
`--local`, `--linked` and `--project-ref` are deprecated aliases. The local Storage gateway
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
| `<workdir>/supabase/.env*`, `<workdir>/.env*`  | dotenv     | always, to resolve `SUPABASE_YES` (CLI-1878) and, on both backends, for `env(VAR)` interpolation while loading `config.toml`; on the local, legacy-backend path also the `SUPABASE_API_*` overrides for the gateway URL/TLS (#6452) and `SUPABASE_AUTH_{JWT_SECRET,SERVICE_ROLE_KEY}` for the service-role key                                                                                                                                                                          |

## Files Written

| Path                                           | Format | When                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | post-run, remote project — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | post-run (always)                                                                                                                                                      |

## API Routes

Auth: `apikey` always; `Authorization: Bearer <key>` unless the key is `sb_`-prefixed.

| Method   | Path                                      | Request body                                                                                                                                                                                                                            | Response                                              |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DELETE` | `/storage/v1/object/{bucket}`             | `{prefixes}` (chunked by 1000)                                                                                                                                                                                                          | `[{name, ...}]`                                       |
| `DELETE` | `/storage/v1/bucket/{id}`                 | — (recursive on an empty prefix)                                                                                                                                                                                                        | `{message}`                                           |
| `POST`   | `/storage/v1/object/list/{bucket}`        | `{prefix, search?, limit:100, offset?}` (recursive walk)                                                                                                                                                                                | `[{name, id?}]`                                       |
| `GET`    | `/storage/v1/bucket`                      | — (no-args + `-r`: delete all buckets)                                                                                                                                                                                                  | `[{name, id}]`                                        |
| `GET`    | `/v1/projects`                            | — (Management API; project picker: bare `--remote` with no ref from `SUPABASE_PROJECT_ID` or `.temp/project-ref`, with stdin and stdout TTYs and a non-JSON output format)                                                              | `[{id, name, organization_slug, region}]`             |
| `GET`    | `/v1/projects/{parent}/branches`          | — (Management API; only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project)      | `[{id, name, project_ref, is_default}]`               |
| `GET`    | `/v1/branches/{id}`                       | — (Management API; only for `--remote=<branch UUID>` when no project is linked)                                                                                                                                                         | `{ref, status, …}`                                    |
| `GET`    | `/v1/projects/{ref}/api-keys?reveal=true` | — (remote project, Management API; skipped when `SUPABASE_AUTH_SERVICE_ROLE_KEY` is set to a non-empty value in the shell env)                                                                                                          | service-role key                                      |
| `GET`    | `/v1/projects/{ref}`                      | — (remote project, Management API; best-effort cache fill after the ref resolves, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored) | `ref`, `name`, `organization_id`, `organization_slug` |

## Environment Variables

`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICES_HOSTNAME`, and the `SUPABASE_API_*`
override family are legacy backend only. `SUPABASE_AUTH_SERVICE_ROLE_KEY` is legacy backend only
for the local target; on a remote project a non-empty shell value skips the api-keys call under either
backend. `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, and `SUPABASE_EXPERIMENTAL_STACK`
(backend selection) apply to either backend. `SUPABASE_YES` auto-confirms the local per-bucket
prompt from the shell env OR the project `.env`/`.env.local`/`.env.<env>[.local]` files (shell
wins); for a remote project only `--yes` or a shell `SUPABASE_YES` counts.
`SUPABASE_PROJECT_ID` supplies the ref for a bare `--remote` and the parent project for `--remote=<branch>`.

`storage` is an experimental command: `rm` requires `--experimental`
(or `SUPABASE_EXPERIMENTAL`), else it exits 1 with
`must set the --experimental flag to run this command` before any other work.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success (including a confirmation declined at the text-mode prompt, and a tolerated `Bucket not found`)                                                                                                                                                                             |
| `1`  | local target, any resolved non-text output mode without `--yes`/`SUPABASE_YES` (`StorageRmConfirmationRequiredError`) — there is no prompt to ask on, so nothing is deleted and no Storage request is sent (a run with no paths and no `-r` reports the missing-`-r` failure first) |
| `1`  | resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a directory (`StorageWorkdirError`) — beats every other guard, including any `DELETE` call                                                                                                                           |
| `1`  | an explicit `--workdir`/`SUPABASE_WORKDIR` on a LOCAL target holds no project config (`StorageMissingProjectConfigError`) — also beats any `DELETE` call                                                                                                                            |
| `1`  | invalid/parse url, missing bucket (root path), missing `-r` flag (directory or no args), object-not-found (recursive empty prefix), API non-2xx, network, auth, config parse                                                                                                        |
| `1`  | two of `--remote`, `--linked` and `--local`, or `--project-ref` with `--local` or `--remote=<value>` (`TargetSelectorConflictError`, `TargetProjectRefConflictError`), after the experimental gate and the workdir check and before any Storage request                             |
| `1`  | `--remote=<db-url>` (`TargetNeedsProjectError`): the Storage API needs a project, not a database URL; no Storage request is sent                                                                                                                                                    |
| `1`  | `--remote=<branch>` matches no branch of the linked project (`LinkBranchNotFoundError`, lists the branches that exist)                                                                                                                                                              |
| `1`  | remote project without consent: a JSON, piped or non-interactive run without `--yes`/shell `SUPABASE_YES` (`HostedMutationConsentRequiredError`), or a declined prompt (`HostedMutationDeclinedError`) — nothing is deleted                                                         |
| `1`  | stack backend: Storage disabled or its stack `failed`/`stopped` (`StackStorageCapabilityError`)                                                                                                                                                                                     |
| `1`  | stack backend: stack is not registered/ready, has no primary database, or the stack API is unavailable (`StackStorageUnavailableError`); a missing Storage endpoint is a capability failure (`StackStorageCapabilityError`)                                                         |

## Output

### `--output-format text`

- Local target: `Confirm deleting files in bucket <bold bucket>?` prompt (default no);
  `--yes`/`SUPABASE_YES` echoes `<label> [y/N] y` and proceeds.
- Linked project: one plan line per bucket (`Delete from <bucket>: <prefixes>`), then a single
  `Delete objects in <N> bucket(s)?` prompt (default No); `--yes`/shell `SUPABASE_YES` echoes
  `Confirmed by --yes: …` and proceeds.
- `Deleting objects: [<space-separated prefixes>]` per delete batch (stderr).
- `Object not found: <prefix>` (non-recursive) / `Deleting bucket: <bucket>` /
  `Bucket not found: <bucket>` (stderr).

### `--output-format json`

Requires `--yes`/`SUPABASE_YES`; without it the run fails rather than defaulting the unaskable
confirmation to no and reporting an empty deletion. On the local stack it fails with
`StorageRmConfirmationRequiredError` before any Storage request; on a remote project it fails with
`HostedMutationConsentRequiredError` once the bucket plan is known and before anything is deleted.
This applies to the resolved output mode, so it also covers the JSON a detected or
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

| Event                  | When                                       | Notable properties                      |
| ---------------------- | ------------------------------------------ | --------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `flags` (recursive/remote/linked/local) |

## Notes

- **Target.** With no selector the command runs against the local stack; when the directory is
  linked the local `Target:` banner ends with `· default; pass --remote for <project>`. `--remote`
  targets the linked project (`SUPABASE_PROJECT_ID`, else `.temp/project-ref`). `--remote=<value>`
  is read as a project ref (20 lowercase letters), `true|yes|on|1` (the linked project), or
  otherwise the name of a branch of the linked project, which resolves to that branch's own project.
  A database URL (`--remote=<db-url>`) fails with a `needs a project, not a database URL` error and
  sends no request. `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to target the local Storage API.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to target the local Storage API.` A bare `--remote` followed by a word that
  exactly matches a branch of the linked project, is within a small edit distance of one, or can't
  be checked because the branch listing failed stops the run with an error that offers both
  readings: `--remote=<word>` for the branch, `<word> --remote` for the operand. Any other word runs
  as the operand. The resolved target is announced on stderr (`Target: …`)
  in every output format and, in JSON results, as a `target` object.
- **Deprecated selectors.** `--linked`, `--project-ref` and `--local` are hidden aliases that still
  select their target and print a warning on stderr naming the replacement, for example
  `--linked is deprecated and will be removed in v4. Use --remote instead: supabase storage rm <file>... --remote`
  and `--local isn't needed (local is the default) and will be removed in v4: supabase storage rm <file>...`.
  Two selectors together fail
  (`Only one of --remote, --linked, --db-url and --local can be set; got …`), `--project-ref` cannot
  be combined with `--local` or `--remote=<value>`, an empty `--project-ref` is rejected, and
  `--linked=false` selects nothing.
- **Target banner.** A remote project prints `Target: …` to stderr once its ref resolves; the local
  target prints `Target: local stack (<host>:<port>)` once the Storage endpoint is known. Both come
  before the first Storage request.
- Validation (missing bucket, missing `-r` for a directory) runs before any network call;
  the no-args missing-`-r` error runs after the client is built, and keeps beating the
  confirmation refusal in every output mode.
- **Hosted consent.** A remote project asks once, after the bucket plan is known (for `-r` with no
  paths, after the bucket list) and before the first delete, with default No. A shell
  `SUPABASE_YES` or `--yes` grants it; a `SUPABASE_YES` in `supabase/.env` and a piped answer do not.
  JSON, piped, agent and non-TTY runs without `--yes` exit 1 with
  `HostedMutationConsentRequiredError`; a declined prompt exits 1 with `HostedMutationDeclinedError`
  (`context canceled`) and deletes nothing.
- On the local stack, a confirmation declined at the text-mode prompt skips that bucket and is not an
  error; a resolved non-text output mode has no prompt to decline, so it hard-fails without
  `--yes` instead (`StorageRmConfirmationRequiredError`), before the Storage gateway is
  contacted. "Resolved" covers `--output-format json|stream-json` and agent-selected JSON
  alike; `-o`/`--output` does not select an output format for `rm` (it stays text), so `rm`
  keeps the text prompt and its piped-answer handling, and an explicit `-o` also opts out of
  the agent JSON default.
- Explicit deletes are attempted first ("in case the paths resolve to extensionless files");
  prefixes not returned as removed are then walked recursively when `-r` is set.
- Object deletes are chunked at `DELETE_OBJECTS_LIMIT` (1000) per request.
- **Stack backend (local target).** The Storage endpoint comes from the selected composition's
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
