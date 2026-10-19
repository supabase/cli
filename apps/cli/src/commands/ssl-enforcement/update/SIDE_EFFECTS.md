# `supabase ssl-enforcement update`

## Files Read

| Path                                           | Format                    | When                                                                                                                                                               |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write                                                          |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are both unset, and as the linked parent for `--remote=<branch>`; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves (only if flag validation passes), on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — including flag-validation failures. Not written if the gate is closed.                                                                                                                                                                  |

## API Routes

| Method | Path                                 | Auth         | Request body                             | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ------------------------------------ | ------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                       | Bearer token | none                                     | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{parent}/branches`     | Bearer token | none                                     | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`                  | Bearer token | none                                     | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `PUT`  | `/v1/projects/{ref}/ssl-enforcement` | Bearer token | `{requestedConfig: {database: boolean}}` | `{currentConfig: {database: boolean}, appliedSuccessfully: boolean}`                                                                                                                                                                                     |
| `GET`  | `/v1/projects/{ref}`                 | Bearer token | none                                     | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring → `~/.supabase/access-token`)                                       |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                                   | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag                                                                  | no (pass `--experimental` instead; one of the two is required)                                |
| `SUPABASE_YES`          | confirms the hosted mutation without asking; only the shell environment counts, never `supabase/.env`                     | no (falls back to the interactive prompt)                                                     |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — SSL enforcement status (post-update) printed to stdout                                                                                                                                                       |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) — checked in `.command.ts`, before the handler (and its flag validation/telemetry) ever runs                               |
| `1`  | neither `--enable-db-ssl-enforcement` nor `--disable-db-ssl-enforcement` set (`SslEnforcementNoEnableDisableFlagError`)                                                                                                |
| `1`  | both `--enable-db-ssl-enforcement` and `--disable-db-ssl-enforcement` set (`SslEnforcementMutuallyExclusiveFlagsError`)                                                                                                |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref)                                                                                   |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | API non-200 (`SslEnforcementUpdateUnexpectedStatusError`)                                                                                                                                                              |
| `1`  | transport failure (`SslEnforcementUpdateNetworkError`)                                                                                                                                                                 |
| `1`  | declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed                                                                                                           |
| `1`  | JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed                                                                                             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--remote` → `true` (bare), the ref, or `<redacted>`; `--project-ref` → the ref when ref-shaped, else `<redacted>`; `--enable-db-ssl-enforcement` / `--disable-db-ssl-enforcement` booleans pass through) |

## Output

### `--output-format text` (default)

Same status-line shape as `get`:

```
SSL is being enforced.
```

or

```
SSL is *NOT* being enforced.
```

### `--output {json,yaml,toml,env}`

### `--output pretty`

Same as `text` mode.

### `--output-format json`

The full response object emitted as the `success` event payload:

```json
{ "currentConfig": { "database": true }, "appliedSuccessfully": true }
```

### `--output-format stream-json`

One `result` event:

```ndjson
{"type":"result","data":{"currentConfig":{"database":true},"appliedSuccessfully":true}}
```

## Notes

- `--enable-db-ssl-enforcement` and `--disable-db-ssl-enforcement` are mutually exclusive,
  enforced at handler entry rather than at flag-parse time.
- The request body always carries `database: <enableDbSslEnforcement>`; passing
  `--disable-db-ssl-enforcement` is the user-facing way to send `database: false`.
- `linked-project.json` is **not** written if flag validation fails (no ref is
  resolved). `telemetry.json` is written regardless — but only once the `--experimental` gate
  is open, since the flag-validation/telemetry-writing handler never runs at all when the gate
  is closed.
- The `--output` flag wins over `--output-format` when both are provided.
- `ssl-enforcement` is an experimental command: `update` requires
  `--experimental` (or `SUPABASE_EXPERIMENTAL`), checked before the login check.
  A closed gate exits 1 before the enable/disable mutex check, project-ref
  resolution, the API call, the `linked-project.json` write, the `telemetry.json` write, and the
  `cli_command_executed` event.
- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Asks `Enable SSL enforcement for database connections on <target>?` (`Disable SSL enforcement for database connections on <target>?` with `--disable-db-ssl-enforcement`; default No) before the first write. `--yes` or a shell `SUPABASE_YES` confirms without asking; a piped `y` on stdin is never read. Without `--yes`, a non-interactive, JSON, stream-json or `-o` run fails with `HostedMutationConsentRequiredError`, and declining fails with `HostedMutationDeclinedError`; neither changes anything.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase ssl-enforcement update` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes
  no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
