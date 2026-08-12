# `supabase link`

Native TypeScript port of Go's `internal/link`. Writes flat state files under
`<workdir>/supabase/.temp/` — it does **not** use the `next/` `.supabase/project.json` model.

TS-only divergence from Go (CLI-2167): `link` accepts an optional `[ref-or-branch]` positional
argument, and `--project-ref` also accepts a branch name instead of a project ref. A value is
treated as a ref when it matches `PROJECT_REF_PATTERN` (20 lowercase letters); any other
non-empty value is looked up as a branch name of the currently-linked parent project. No Go
counterpart exists for this behavior.

## Files Read

| Path                                 | Format              | When                                                                                                                                                                     |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/config.toml`               | TOML (`project_id`) | NOT read for ref resolution itself — read by `LegacyCliConfig` for workdir/project-id discovery generally (`--workdir` resolution, `SUPABASE_PROJECT_ID` passthrough)    |
| `supabase/.temp/linked-project.json` | JSON (`ref` field)  | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 2nd parent-project candidate for branch-name resolution (CLI-2167, TS-only)        |
| `supabase/.temp/project-ref`         | plain text          | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 3rd (last) parent-project candidate for branch-name resolution (CLI-2167, TS-only) |
| `~/.supabase/access-token`           | plain text          | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring is unavailable                                                                                                     |

> For resolving the final linked ref, the on-disk `supabase/.temp/project-ref` file is **not**
> read — Go passes an empty in-memory FS to `ParseProjectRef` (`cmd/link.go:30`), so `link` never
> falls back to it there. It **is** read for the TS-only branch-name lookup above, which resolves
> the currently-linked _parent_ project (env `SUPABASE_PROJECT_ID` → `linked-project.json` →
> `project-ref` file, first ref-shaped candidate wins) before searching its branches. This
> deliberately does NOT reuse `LegacyProjectRefResolver.resolveOptional` — that resolves the
> FINAL linked ref, which right after linking a branch would be the branch's own ref, breaking a
> second `link <other-branch>` (CLI-2167 follow-up). `linked-project.json` works as the parent
> candidate because `link` only writes it for a real (non-404) project — the branch/404 path
> leaves it untouched — and `LegacyLinkedProjectCache.cache` never overwrites an existing file, so
> it reliably holds the last real parent project even after subsequent branch links. This parent
> resolution is hoisted into `legacy/shared/legacy-parent-project-ref.ts`
> (`legacyResolveLinkedParentRef`), shared with the `branches` command family, which is
> PARENT-scoped for the same reason — see `branches/list/SIDE_EFFECTS.md`.

## Files Written

All under `<workdir>/supabase/.temp/` (plain text, created with parent dirs as needed):

| Path                  | When                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `project-ref`         | always, after services link (mandatory — a write failure fails the command)                           |
| `postgres-version`    | when the project status is 200 and `database.version` is non-empty                                    |
| `storage-migration`   | best-effort — storage config `migrationVersion`                                                       |
| `pooler-url`          | best-effort — processed PRIMARY pooler connection string; **removed** when `--skip-pooler`            |
| `rest-version`        | best-effort — PostgREST swagger `info.version`, prefixed `v`                                          |
| `gotrue-version`      | best-effort — GoTrue `/auth/v1/health` version                                                        |
| `storage-version`     | best-effort — Storage `/storage/v1/version` body, prefixed `v`                                        |
| `linked-project.json` | best-effort — `{ref,name,organization_id,organization_slug}` (only for a resolvable, non-404 project) |

## API Routes

Management API (base `LegacyCliConfig.apiUrl`, `Authorization: Bearer <access-token>`):

| Method | Path                                        | When                                                                                            |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}`                        | always (404 tolerated for branch projects)                                                      |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true`   | always                                                                                          |
| `GET`  | `/v1/projects/{ref}/config/storage`         | best-effort                                                                                     |
| `GET`  | `/v1/projects/{ref}/config/database/pooler` | best-effort (unless `--skip-pooler`)                                                            |
| `GET`  | `/v1/projects`                              | only when prompting on a TTY                                                                    |
| `GET`  | `/v1/projects/{parentRef}/branches`         | only when a non-ref-shaped `[ref-or-branch]`/`--project-ref` value is given (CLI-2167, TS-only) |

Tenant service gateway (`https://<ref>.<projectHost>`, `apikey: <service-key>` + `Authorization: Bearer <service-key>`):

| Method | Path                  | When        |
| ------ | --------------------- | ----------- |
| `GET`  | `/rest/v1/`           | best-effort |
| `GET`  | `/auth/v1/health`     | best-effort |
| `GET`  | `/storage/v1/version` | best-effort |

> The discarded Go config probes (`/config/database/postgres`, `/postgrest`, `/config/auth`,
> `/network-restrictions`) are **omitted**: they only populated in-process config that standalone
> `link` discards, and they emit nothing observable.

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

### `--output-format text` (Go-compatible)

- stderr: `Selected project: <ref>` (prompt path); `WARNING: Project status is <status> instead of Active Healthy. Some operations might fail.`; the dashboard unpause suggestion on a paused project.
- stderr: `Resolved branch "<name>" of project <parentRef> to project ref <branchRef>.` — via
  `output.raw(..., "stderr")` (NOT `output.info`, which clack renders on stdout with `│`/`◇`
  framing in text mode) — only when a non-ref-shaped `[ref-or-branch]`/`--project-ref` value
  resolved to a branch (CLI-2167, TS-only).
- spinner: `Resolving branch...` while listing branches for a branch-name lookup (CLI-2167,
  TS-only; suppressed in `json`/`stream-json` mode like every other `output.task`).
- stdout: `Finished supabase link.`

### `--output-format json` / `stream-json`

Emits a structured success (`{ project_ref }`) and suppresses the human `Finished` line. When a
branch name/UUID was resolved, the payload additionally carries `branch` (the resolved branch's
name) and `parent_project_ref` (CLI-2167, TS-only, purely additive — absent for a plain
project-ref link). The `Resolved branch "<name>"...` line above still goes out via `output.info`
in these modes (stderr in `json`; a structured `log` event in `stream-json`) rather than
`output.raw`. Warnings still go to stderr.

## Known divergence

- The cosmetic `WARNING: Local database version differs from the linked project.` message (Go's
  `linkPostgresVersion`) is **not** reproduced: it requires loading the local `config.toml`
  `[db].major_version` with CLI defaults, which the legacy shell does not surface. The
  `postgres-version` file (the meaningful side effect) is still written.
- The `Finished supabase link.` line is emitted as **plain text**; Go renders `supabase link` in
  ANSI cyan via `utils.Aqua`. This matches the established legacy-port convention (color helpers are
  rendered plain); ANSI-stripping scripts are unaffected.
