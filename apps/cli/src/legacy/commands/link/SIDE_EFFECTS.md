# `supabase link`

Writes flat state files under `<workdir>/supabase/.temp/` — it does **not** use
the `next/` `.supabase/project.json` model.

TS-only divergence from Go (CLI-2167): `link` accepts an optional `[ref-or-branch]` positional
argument, and `--project-ref` also accepts a branch name instead of a project ref. A value is
treated as a ref when it matches `PROJECT_REF_PATTERN` (20 lowercase letters); any other
non-empty value is looked up as a branch name of the currently-linked parent project. No Go
counterpart exists for this behavior.

## Files Read

| Path                                 | Format                                  | When                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`               | TOML (`project_id`, `db.major_version`) | NOT read for ref resolution. `LegacyCliConfig` uses it for workdir/project-id. After writing `postgres-version`, `link` also reads `[db] major_version` so it can align the shadow major to the remote. |
| `supabase/.temp/linked-project.json` | JSON (`ref` field)                      | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 2nd parent-project candidate for branch-name resolution (CLI-2167, TS-only)                                       |
| `supabase/.temp/project-ref`         | plain text                              | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 3rd (last) parent-project candidate for branch-name resolution (CLI-2167, TS-only)                                |
| `~/.supabase/access-token`           | plain text                              | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring is unavailable                                                                                                                                    |

> For resolving the final linked ref, the on-disk `supabase/.temp/project-ref` file is **not**
> read — `link` never falls back to it there. It **is** read for the TS-only branch-name lookup above, which resolves
> the currently-linked _parent_ project (env `SUPABASE_PROJECT_ID` → `linked-project.json` →
> `project-ref` file, first ref-shaped candidate wins) before searching its branches. This
> deliberately does NOT reuse `LegacyProjectRefResolver.resolveOptional` — that resolves the
> FINAL linked ref, which right after linking a branch would be the branch's own ref, breaking a
> second `link <other-branch>` (CLI-2167 follow-up). `linked-project.json` works as the parent
> candidate because `link`'s plain-project arm writes it for a real (non-404) project, and the 404
> (branch) arm ALSO best-effort maintains it now (PR #6168 review — see Files Written below for the
> two 404-path cases): without this, a `link <branch-name>` whose parent was resolved from the
> `project-ref` FILE (env/cache absent or malformed) would never persist that parent evidence
> anywhere — the branch ref 404s at `LegacyLinkedProjectCache.cache`'s own GET too — so it would be
> lost until a real (non-404) `link` run. `LegacyLinkedProjectCache.cache` (the post-run
> PersistentPostRun-parity fill) never overwrites an EXISTING file either way, so between the two,
> the cache reliably tracks the last known-good parent project even across subsequent branch links.
> This parent resolution is hoisted into `legacy/shared/legacy-parent-project-ref.ts`
> (`legacyResolveLinkedParentRef`), shared with the `branches` command family, which is
> PARENT-scoped for the same reason — see `branches/list/SIDE_EFFECTS.md`.

## Files Written

All under `<workdir>/supabase/.temp/` (plain text, created with parent dirs as needed):

| Path                  | When                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-ref`         | always, after services link (mandatory — a write failure fails the command)                                                                                                                                                                                                                                                                                                              |
| `postgres-version`    | when the project status is 200 and `database.version` is non-empty                                                                                                                                                                                                                                                                                                                       |
| `../config.toml`      | when `postgres-version` is written and `[db] major_version` differs from the remote major — rewritten in place. Prints `Shadow major is now N (was M). The running local database is still M. Next: supabase db reset`                                                                                                                                                                   |
| `storage-migration`   | best-effort — storage config `migrationVersion`                                                                                                                                                                                                                                                                                                                                          |
| `pooler-url`          | best-effort — processed PRIMARY pooler connection string; **removed** when `--skip-pooler`                                                                                                                                                                                                                                                                                               |
| `rest-version`        | best-effort — PostgREST swagger `info.version`, prefixed `v`                                                                                                                                                                                                                                                                                                                             |
| `gotrue-version`      | best-effort — GoTrue `/auth/v1/health` version                                                                                                                                                                                                                                                                                                                                           |
| `storage-version`     | best-effort — Storage `/storage/v1/version` body, prefixed `v`                                                                                                                                                                                                                                                                                                                           |
| `linked-project.json` | best-effort — `{ref,name,organization_id,organization_slug}` for a resolvable, non-404 project; on the 404 (branch) path, best-effort WRITTEN as a ref-only `{ref}` record when a name/UUID-resolved branch's parent isn't already cached (PR #6168 review), or best-effort DELETED when a raw ref-shaped branch link's existing cache is verifiably for a different project (see below) |

> **404-path cache maintenance is TS-only (PR #6168 review) — Go never writes or deletes this file
> for a branch ref at all.** Two cases, both best-effort (`Effect.ignore`/caught, never affect
> `link`'s outcome, no new exit code):
>
> - `link <branch-name-or-uuid>` (name resolution ran, so the parent is KNOWN): if the existing
>   cache doesn't already agree with that parent, write `{"ref": "<parentRef>"}` — a
>   richer cache (with `name`/org fields, e.g. from a real `link <parent-ref>` run) is left
>   untouched rather than downgraded to the ref-only shape.
> - `link <raw-ref-shaped-branch-ref>` (no name resolution — the parent is unknown here): when an
>   existing cache names a DIFFERENT project than this ref, best-effort correlate the two (one
>   extra `GET /v1/projects/{cachedRef}/branches` call, see API Routes below) — if `ref` is
>   verifiably among that project's branches, the cache is still accurate and is left alone; if
>   it's verifiably NOT, the cache is stale for a different project and is deleted (better no
>   parent claim than silently misdirecting every parent-scoped command at the wrong project). Any
>   lookup failure or timeout ALSO deletes the cache — fail-safe, not fail-convenient: an
>   unverified divergent cache is treated as untrustworthy. Similarly, when a name/UUID-resolved
>   branch link cannot REPLACE a divergent cache (write failure), the stale cache is deleted
>   rather than left trusted.
>
> This diverges from Go's filesystem behavior on the branch/404 link path (Go never touches this
> file there at all) — flag if the cli-e2e parity harness's filesystem-comparison dimension
> exercises a branch/404 `link` scenario.

## API Routes

Management API (base `LegacyCliConfig.apiUrl`, `Authorization: Bearer <access-token>`):

| Method | Path                                        | When                                                                                                                                                                       |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}`                        | always (404 tolerated for branch projects)                                                                                                                                 |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true`   | always                                                                                                                                                                     |
| `GET`  | `/v1/projects/{ref}/config/storage`         | best-effort                                                                                                                                                                |
| `GET`  | `/v1/projects/{ref}/config/database/pooler` | best-effort (unless `--skip-pooler`)                                                                                                                                       |
| `GET`  | `/v1/projects`                              | only when prompting on a TTY                                                                                                                                               |
| `GET`  | `/v1/projects/{parentRef}/branches`         | only when a non-ref-shaped `[ref-or-branch]`/`--project-ref` value is given (CLI-2167, TS-only)                                                                            |
| `GET`  | `/v1/projects/{cachedRef}/branches`         | 404-path stale-cache correlation only: a RAW ref-shaped branch link whose existing `linked-project.json` names a different project (PR #6168 review, TS-only, best-effort) |

Tenant service gateway (`https://<ref>.<projectHost>`, `apikey: <service-key>` + `Authorization: Bearer <service-key>`):

| Method | Path                  | When        |
| ------ | --------------------- | ----------- |
| `GET`  | `/rest/v1/`           | best-effort |
| `GET`  | `/auth/v1/health`     | best-effort |
| `GET`  | `/storage/v1/version` | best-effort |

> Certain config probes the old Go CLI made (`/config/database/postgres`, `/postgrest`,
> `/config/auth`, `/network-restrictions`) are **omitted** here: they only populated in-process
> config that standalone `link` discards, and they emit nothing observable.

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_PROJECT_ID`   | link-target resolution: `[ref-or-branch]` positional → `--project-ref` → env → TTY prompt (CLI-2167 adds the positional ahead of the flag). Also the 1st parent-project candidate for a TS-only branch-name lookup (CLI-2167). |
| `SUPABASE_ACCESS_TOKEN` | Management API bearer auth (env → keyring → `~/.supabase/access-token`)                                                                                                                                                        |
| `SUPABASE_DB_PASSWORD`  | bound to `--password`; **accepted but a no-op** for `link` (the DB-connection path that would consume it is dead code in Go)                                                                                                   |

## Exit Codes

| Code | Condition                                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — project linked (incl. the 404 branch path); prints `Finished supabase link.`                                                                                                   |
| `1`  | non-TTY with no `--project-ref` / `SUPABASE_PROJECT_ID` (`required flag(s) "project-ref" not set`)                                                                                       |
| `1`  | malformed project ref — only reachable via `SUPABASE_PROJECT_ID`/TTY prompt now; a malformed `[ref-or-branch]`/`--project-ref` value takes the CLI-2167 branch-lookup path below instead |
| `1`  | project paused (`INACTIVE`)                                                                                                                                                              |
| `1`  | project status non-200/404                                                                                                                                                               |
| `1`  | api-keys auth failure / missing key                                                                                                                                                      |
| `1`  | `project-ref` file write failure                                                                                                                                                         |
| `1`  | both `[ref-or-branch]` and `--project-ref` given (CLI-2167, TS-only)                                                                                                                     |
| `1`  | non-ref-shaped `[ref-or-branch]`/`--project-ref` value with no linked parent project at all (CLI-2167, TS-only)                                                                          |
| `1`  | a parent-project candidate exists but none is ref-shaped — corrupt/stale linked state (CLI-2167, TS-only)                                                                                |
| `1`  | branch name/UUID not found on the linked parent project (CLI-2167, TS-only)                                                                                                              |
| `1`  | branch resolved but has no `project_ref` yet (still provisioning) (CLI-2167, TS-only)                                                                                                    |
| `1`  | branch listing failure (network/status) during branch-name resolution (CLI-2167, TS-only)                                                                                                |

> Best-effort service-link and telemetry errors never affect the exit code.

## Output

### `--output-format text`

- stderr: `Selected project: <ref>` (prompt path); `WARNING: Project status is <status> instead of Active Healthy. Some operations might fail.`; the dashboard unpause suggestion on a paused project.
- stderr: `Resolved branch "<name>" of project <parentRef> to project ref <branchRef>.` — via
  `output.raw(..., "stderr")` (NOT `output.info`, which clack renders on stdout with `│`/`◇`
  framing in text mode) — only when a non-ref-shaped `[ref-or-branch]`/`--project-ref` value
  resolved to a branch (CLI-2167, TS-only).
- spinner: `Resolving branch...` while listing branches for a branch-name lookup (CLI-2167,
  TS-only; suppressed in `json`/`stream-json` mode like every other `output.task`).
- stdout: `Finished supabase link.`
- stdout (info): `Shadow major is now N (was M). The running local database is still M. Next: supabase db reset` when
  `config.toml` `[db] major_version` was rewritten to match the remote.

### `--output-format json` / `stream-json`

Emits a structured success (`{ project_ref }`) and suppresses the human `Finished` line. When a
branch name/UUID was resolved, the payload additionally carries `branch` (the resolved branch's
name) and `parent_project_ref` (CLI-2167, TS-only, purely additive — absent for a plain
project-ref link). The `Resolved branch "<name>"...` line above still goes out via `output.info`
in these modes (stderr in `json`; a structured `log` event in `stream-json`) rather than
`output.raw`. Warnings still go to stderr.

## Known divergence

- When `postgres-version` is written and `[db] major_version` in `supabase/config.toml` differs
  from the remote major, `link` rewrites the TOML and prints
  `Shadow major is now N (was M). The running local database is still M. Next: supabase db reset`. The old Go CLI only
  warned that the versions differed.
- The `Finished supabase link.` line is emitted as **plain text**; the old Go CLI rendered
  `supabase link` in ANSI cyan. This matches the established legacy-port convention (color
  helpers are rendered plain); ANSI-stripping scripts are unaffected.
