# `supabase link`

Writes flat state files under `<workdir>/supabase/.temp/`.

TS-only divergence from Go (CLI-2167): `link` accepts an optional `[ref-or-branch]` positional
argument, and `--project-ref` also accepts a branch name instead of a project ref. A value is
treated as a ref when it matches `PROJECT_REF_PATTERN` (20 lowercase letters); any other
non-empty value is looked up as a branch name of the currently-linked parent project. No Go
counterpart exists for this behavior.

## Files Read

| Path                                 | Format              | When                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/config.toml`               | TOML (`project_id`) | NOT read for ref resolution itself — read by `CommandSettings` for workdir/project-id discovery generally (`--workdir` resolution, `SUPABASE_PROJECT_ID` passthrough)                                                                                        |
| `supabase/.temp/linked-project.json` | JSON (`ref` field)  | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 2nd parent-project candidate for branch-name resolution (CLI-2167, TS-only)                                                                                            |
| `supabase/.temp/project-ref`         | plain text          | only when the given `[ref-or-branch]`/`--project-ref` value is not ref-shaped, as the 3rd (last) parent-project candidate for branch-name resolution (CLI-2167, TS-only)                                                                                     |
| `~/.supabase/access-token`           | plain text          | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring is unavailable                                                                                                                                                                                         |
| `$SUPABASE_HOME/stacks/<id>/`        | JSON                | stack mode only, when the lock is written and the lease is released: saved stack state and database data records, to warn about data a new pin would be refused by; nothing is created, locked or probed (see "Hosted versions in `supabase/supabase.lock`") |

> For resolving the final linked ref, the on-disk `supabase/.temp/project-ref` file is **not**
> read — `link` never falls back to it there. It **is** read for the TS-only branch-name lookup above, which resolves
> the currently-linked _parent_ project (env `SUPABASE_PROJECT_ID` → `linked-project.json` →
> `project-ref` file, first ref-shaped candidate wins) before searching its branches. This
> deliberately does NOT reuse `RemoteTarget.resolveOptional` — that resolves the
> FINAL linked ref, which right after linking a branch would be the branch's own ref, breaking a
> second `link <other-branch>` (CLI-2167 follow-up). `linked-project.json` works as the parent
> candidate because `link`'s plain-project arm writes it for a real (non-404) project, and the 404
> (branch) arm ALSO best-effort maintains it now (PR #6168 review — see Files Written below for the
> two 404-path cases): without this, a `link <branch-name>` whose parent was resolved from the
> `project-ref` FILE (env/cache absent or malformed) would never persist that parent evidence
> anywhere — the branch ref 404s at `LinkedProjectCache.cache`'s own GET too — so it would be
> lost until a real (non-404) `link` run. `LinkedProjectCache.cache` (the post-run
> PersistentPostRun-parity fill) never overwrites an EXISTING file either way, so between the two,
> the cache reliably tracks the last known-good parent project even across subsequent branch links.
> This parent resolution is `RemoteTarget.parent`
> in `config/remote-target.layer.ts`, shared with the `branches` command family, which is
> PARENT-scoped for the same reason — see `branches/list/SIDE_EFFECTS.md`.

## Files Written

All under `<workdir>/supabase/.temp/` (plain text, created with parent dirs as needed):

| Path                  | When                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-ref`         | always, after services link (mandatory — a write failure fails the command)                                                                                                                                                                                                                                                                                                              |
| `postgres-version`    | when the project status is 200 and `database.version` is non-empty                                                                                                                                                                                                                                                                                                                       |
| `storage-migration`   | best-effort — storage config `migrationVersion`                                                                                                                                                                                                                                                                                                                                          |
| `pooler-url`          | best-effort — processed PRIMARY pooler connection string; **removed** when `--skip-pooler`                                                                                                                                                                                                                                                                                               |
| `rest-version`        | best-effort — PostgREST swagger `info.version`, prefixed with `v` unless it already starts with `v`                                                                                                                                                                                                                                                                                      |
| `gotrue-version`      | best-effort — GoTrue `/auth/v1/health` version                                                                                                                                                                                                                                                                                                                                           |
| `storage-version`     | best-effort — Storage `/storage/v1/version` body, prefixed with `v` unless it already starts with `v`                                                                                                                                                                                                                                                                                    |
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

Management API (base `CommandSettings.apiUrl`, `Authorization: Bearer <access-token>`):

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

| Variable                      | Purpose                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_PROJECT_ID`         | link-target resolution: `[ref-or-branch]` positional → `--project-ref` → env → TTY prompt (CLI-2167 adds the positional ahead of the flag). Also the 1st parent-project candidate for a TS-only branch-name lookup (CLI-2167). |
| `SUPABASE_ACCESS_TOKEN`       | Management API bearer auth (env → keyring → `~/.supabase/access-token`)                                                                                                                                                        |
| `SUPABASE_DB_PASSWORD`        | **no-op** for `link`: neither this variable nor `--password` is read (the DB-connection path that would consume them is dead code in Go)                                                                                       |
| `SUPABASE_EXPERIMENTAL_STACK` | `1` or `0` selects stack project-state mode over `[experimental] stack`; unset or empty uses the config. Any other value fails the command (see Exit Codes)                                                                    |

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
| `1`  | `SUPABASE_EXPERIMENTAL_STACK` is set to a non-empty value other than `0` or `1` (`must be 0 or 1 when set`); nothing is written                                                          |

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

### `--output-format json` / `stream-json`

Emits a structured success (`{ project_ref }`) and suppresses the human `Finished` line. When a
branch name/UUID was resolved, the payload additionally carries `branch` (the resolved branch's
name) and `parent_project_ref` (CLI-2167, TS-only, purely additive — absent for a plain
project-ref link). The `Resolved branch "<name>"...` line above still goes out via `output.info`
in these modes (stderr in `json`; a structured `log` event in `stream-json`) rather than
`output.raw`. Warnings still go to stderr.

## Stack mode

When stack project-state mode is active (`SUPABASE_EXPERIMENTAL_STACK=1`, or `[experimental] stack`
in `config.toml` with the variable unset), the link target is one gitignored document,
`<workdir>/supabase/.link.json`, and nothing is written under `supabase/.temp/`:

```json
{
  "project": { "ref": "…", "name": "…", "organization_id": "…", "organization_slug": "…" },
  "active_branch": { "ref": "…", "name": "…", "is_default": false, "pooler_url": "…" },
  "fetchedAt": "<ISO-8601 timestamp>"
}
```

- `project` is the parent project; `active_branch.ref` is the ref commands act on, which is the
  project's own ref unless a branch was linked (`name` and `is_default` appear for a branch
  resolved by name; a raw branch ref whose parent is unknown records only `is_default: false`). When the ref is a branch project that `getProject` does not return, the
  parent comes from the branch resolution, else from the previous document's project when that
  project still lists the ref as a branch, else the ref itself.
- `pooler_url` uses the same normalization as `.temp/pooler-url`; it is omitted with
  `--skip-pooler` or when the project reports no primary pooler.
- The document is written atomically after `supabase/.gitignore` gains `.link.json`,
  `..link.json.*.tmp` (the staged write), `.supabase.lock.lease`, and `.supabase.lock.*.tmp` (the
  staged lock write). The Postgres version and `linked-project.json` are not written.
- A document that does not decode fails reads with `ProjectLinkMalformedError`, which suggests
  running `supabase link` again; a read or write failure other than absence is
  `ProjectLinkIoError`.
- The organization and project `groupIdentify` calls fire from `link` itself, since the post-run
  linked-project cache fill is a no-op in this mode. For other commands the fill writes
  `$SUPABASE_HOME/project-cache/<ref>.json` (atomic, once per ref; see `docs/supabase-home.md`)
  instead of `.temp/linked-project.json`.

### Hosted versions in `supabase/supabase.lock`

When the project has a `supabase/config.toml`, stack-mode `link` also records what the linked
project or branch runs in `supabase/supabase.lock`. The config is validated first, so an invalid
`supabase/config.toml` fails the link before any probe or write. Without a `config.toml` there is no
lock, only `.link.json` is written, under the same project lease, and nothing below runs. A lease that
stays busy fails the link with `LockResolutionError` reason `lease-busy` before anything is written.
`supabase link` always needs a login. Under the project lease `supabase/.supabase.lock.lease` it:

- Probes the target (the `link.probe` span; `stack update` runs the same probe under `update.probe`):
  the database version from `getProject` (`database.version`), or from `getABranchConfig`
  (`postgres_version`) when the ref is a branch the project lookup does not return, and the `rest`, `auth` and `storage` versions from the target's
  tenant host (`/rest/v1/`, `/auth/v1/health`, `/storage/v1/version`) with the service-role key.
  The key is sent as `apikey`, and as a bearer token unless it is an `sb_` key; it is never logged
  or recorded. Services without a version endpoint are not probed.
- Resolves the entries whose specifier is `linked` (the default) against the observations (the
  `link.lock` span), looking each hosted version up on the slim-services release host
  (`SUPABASE_INTERNAL_SLIM_RELEASES_URL` and `SUPABASE_INTERNAL_SLIM_REGISTRY_URL` redirect it), and
  records every observation in its entry's `linked` field even when a specifier overrides it. The
  lock's top-level `linked` gains the project, the branch (`ref`, `isDefault`; a project link
  without a branch records the project ref as the branch ref, default) and `observedAt`. A branch
  linked by ref or by name records the same identity; its name is kept only in `.link.json`.
- A service the platform does not report, or a hosted version slim-services does not publish
  (`resolution` `unobserved` or `unpublished`), takes the version bundled with the CLI. Services
  with no version endpoint (`realtime`, `imgproxy`, `functions`, `studio`, `pgmeta`, `mail`,
  `analytics`, `pooler`) are recorded as `unobserved` without a warning; one the probe should have
  read (`database`, `rest`, `auth`, `storage`) warns. A database
  whose hosted major differs from `db.major_version` does the same. A hosted or release-host
  failure that is transient keeps the previous entry only when the remote, the specifier and
  `db.major_version` are unchanged, else takes the bundled version as `unobserved`; both print a
  warning with the cause. An entry that fell back and whose inputs are unchanged keeps its pin.
  Linking to another project or branch keeps nothing observed on the old remote. An explicit
  `<upstream>` or `<upstream>-r<N>` specifier that cannot be resolved fails the link, and a release
  integrity mismatch always does.
- Once every entry has resolved, writes `.link.json`, then the lock (sorted-key JSON, atomically)
  only when it differs from the stored one, ignoring `linked.observedAt`, all while holding the
  lease; `supabase/.gitignore` gains its entries when the lease is taken. A resolution failure
  writes neither. The link goes first so a lock never observes a remote the checkout does not
  target: if the lock write fails, `.link.json` already targets the new remote while the lock still
  observes the previous one, the next `start` warns that the lock observed another remote, and
  `supabase stack update` or running `supabase link` again repairs it. The command then prints the
  hosted and locked version of each service and, when the lock changed,
  `Updated supabase/supabase.lock[: now observing <remote>] (<n> version changes). Review and commit it.`,
  else `supabase/supabase.lock is already up to date.`; the report is printed after both writes,
  still under the lease. In JSON output it adds `lock` (`file`, `written`, `services` with
  `service`, `hosted`, `locked`, `resolution`). When the lock was written, the lease is then
  released and the new pins are checked against the database data of every saved stack of this
  project (the `StackLock.dataConflicts` span, which records `lock.data_conflict_count`), by the
  rules the next `supabase stack start` of that stack applies. Each stack whose data would be
  refused gets one warning, `stack <id>: the next supabase start refuses these pins:` followed by
  the failure that start reports: a database build other than a new `-rN` revision of the one that
  initialized the data, or a schema-owning service the stack runs against that database that is
  older than one that already migrated it. The failure names the recorded and refused versions and
  the remedies: restoring the setting in `supabase/config.toml` that selects the recorded version
  (`[local.services.<service>] version`, `[db] major_version` or `[db] orioledb_version`), or
  `supabase stack destroy --stack-id <id>`, which permanently deletes the stack's local database
  data (data with no recorded identity offers only the destroy). The lock stays written, the link
  never fails on this check, and saved state that cannot be read is logged at debug level and
  warns of nothing.

`--frozen`, or `CI` set (not empty, `false` or `0`) with an existing lock, makes `link` write only
`.link.json`: the lock is untouched, no data check runs, and a warning lists the services whose
hosted versions differ from it, advising `supabase stack update`. A missing lock is created even under `CI`. The probes
still run. In legacy mode the flag is accepted and does nothing. `supabase unlink` never touches the
lock.

Network by command: `supabase link` reaches the Management API, the target's tenant host and the
release host. `supabase start` and `supabase stack install` reach only the release host, only when
they resolve a release, and never need a login or the Management API; `supabase stack update`
reaches the Management API and tenant host only when a `linked` entry is re-resolved and
`supabase/.link.json` exists (it then needs a login), plus the release host; `supabase stack
outdated` reaches only the release host.

## Known divergence

- The cosmetic `WARNING: Local database version differs from the linked project.` message is
  **not** reproduced: it requires loading the local `config.toml` `[db].major_version` with CLI
  defaults, which the CLI does not surface. The `postgres-version` file (the meaningful
  side effect) is still written.
- The `Finished supabase link.` line is emitted as **plain text**; the old Go CLI rendered
  `supabase link` in ANSI cyan. This matches the established port convention (color
  helpers are rendered plain); ANSI-stripping scripts are unaffected.
