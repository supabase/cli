# `supabase branches list`

## Files Read

| Path                                           | Format                    | When                                                                                                    |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`         | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliSettings.profile`           |
| keyring `"Supabase CLI"` / `access-token`      | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                |
| `<workdir>/supabase/.temp/linked-project.json` | JSON (`ref` field)        | when `--project-ref` is unset, as the 2nd PARENT-ref candidate (CLI-2167 follow-up, TS-only, see below) |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset, as the 3rd (last) PARENT-ref candidate   |
| `~/.supabase/access-token`                     | plain text (token string) | last-resort fallback after env + keyring miss                                                           |

> `branches` is PARENT-scoped: after `supabase link <branch>`, the on-disk `project-ref` file
> holds the BRANCH's own ref, and the Management API returns 403 for a branch ref on every
> branches-management endpoint. Every `branches` subcommand therefore resolves the project ref
> via `legacyResolveParentScopedProjectRef` (`legacy/shared/legacy-parent-project-ref.ts`) instead
> of calling `LegacyProjectRefResolver.resolve` directly: an explicit `--project-ref` still wins
> outright; otherwise the PARENT is resolved as env `SUPABASE_PROJECT_ID` → `linked-project.json`'s
> `ref` → the `project-ref` file, first ref-shaped candidate wins, falling through to
> `resolver.resolve(None)`'s ordinary env/prompt/not-linked behavior when no candidate is
> ref-shaped. No-op when linked to a real (non-branch) project, since the cache and the
> `project-ref` file then hold the same ref (CLI-2167 follow-up, TS-only divergence).

> Pretty-table rendering ALSO makes its own independent, soft read of `<workdir>/supabase/.temp/project-ref`
> (`LegacyProjectRefResolver.resolveOptional`: env → file, never a prompt, never a failure) to find
> the CURRENTLY linked ref (which may be a branch ref) for the `(active)` marker below — separate
> from, and unconditional on, the PARENT-scoped `ref` resolution above. Missing/unreadable → no
> marker, never an error (CLI-2167 follow-up, TS-only).

## Files Written

| Path                                             | Format | When                                                         |
| ------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command              |

## API Routes

| Method | Path                          | Auth         | Request body | Response (used fields)                                                                                                               |
| ------ | ----------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}/branches` | Bearer token | none         | `[{id, name, project_ref, parent_project_ref, is_default, git_branch?, persistent, status, created_at, updated_at, with_data, ...}]` |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                  | Required?                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                     | no (falls back to keyring → `~/.supabase/access-token`)                                            |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (used by the cli-e2e test harness). | no (defaults to `supabase`)                                                                        |
| `SUPABASE_PROJECT_ID`   | PARENT project ref fallback (1st candidate) when `--project-ref` is unset (CLI-2167 follow-up)                                                                                                                                                                                           | no (also reads `linked-project.json` → `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                        | no (walks up from CWD looking for `supabase/config.toml`)                                          |

## Exit Codes

| Code | Condition                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | success — branches printed to stdout                                            |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, non-TTY  |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`            |
| `1`  | `LegacyBranchesListUnexpectedStatusError` — non-2xx response from list endpoint |
| `1`  | `LegacyBranchesListNetworkError` — transport-level network failure              |
| `1`  | `LegacyBranchesEnvNotSupportedError` — `--output env` flag is rejected          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                       |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` whitelisted) |

## Output

The `--output {pretty,json,yaml,toml,env}` flag and the `--output-format {text,json,stream-json}` flag are both honored. `--output` wins when both are supplied. `pretty` and `text` map to the same Glamour render.

### `--output pretty` (default) / `--output-format text`

Prints a Glamour-styled markdown table with columns `ID`, `NAME`, `DEFAULT`, `GIT BRANCH`, `WITH DATA`, `STATUS`, `CREATED AT (UTC)`, `UPDATED AT (UTC)`.

TS-only QoL (CLI-2167 follow-up, no Go counterpart): the row whose `project_ref` matches the
CURRENTLY linked ref renders its NAME cell as `<name> (active)` — mirrors `next/`'s
`branches list` convention. Pretty-table only; never applies to `--output json|yaml|toml` or
`--output-format json|stream-json`, which stay byte-identical (no `active` field is added there,
unlike `next/`'s JSON payload).

### `--output json`

Indented JSON of the `BranchResponse[]` array with alphabetical keys + trailing newline.

### `--output yaml`

YAML document of the branch array.

### `--output toml`

TOML document wrapping the array as `[[branches]]`.

### `--output env`

Fails with `LegacyBranchesEnvNotSupportedError("--output env flag is not supported")`.

### `--output-format json`

Single JSON object via `Output.success` with `{branches: [...]}` data.

### `--output-format stream-json`

One `result` NDJSON event with `{branches: [...]}`.

## Notes

- Timestamps are formatted as UTC `YYYY-MM-DD HH:MM:SS`.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers.
