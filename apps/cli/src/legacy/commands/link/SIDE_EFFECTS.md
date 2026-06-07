# `supabase link`

Native TypeScript port of Go's `internal/link`. Writes flat state files under
`<workdir>/supabase/.temp/` — it does **not** use the `next/` `.supabase/project.json` model.

## Files Read

| Path                       | Format              | When                                                                                              |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`     | TOML (`project_id`) | for ref resolution when `--project-ref` / `SUPABASE_PROJECT_ID` are unset (via `LegacyCliConfig`) |
| `~/.supabase/access-token` | plain text          | when `SUPABASE_ACCESS_TOKEN` is unset and the keyring is unavailable                              |

> The on-disk `supabase/.temp/project-ref` file is **not** read for ref resolution — Go passes an
> empty in-memory FS to `ParseProjectRef` (`cmd/link.go:30`), so `link` never falls back to it.

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

| Method | Path                                        | When                                       |
| ------ | ------------------------------------------- | ------------------------------------------ |
| `GET`  | `/v1/projects/{ref}`                        | always (404 tolerated for branch projects) |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true`   | always                                     |
| `GET`  | `/v1/projects/{ref}/config/storage`         | best-effort                                |
| `GET`  | `/v1/projects/{ref}/config/database/pooler` | best-effort (unless `--skip-pooler`)       |
| `GET`  | `/v1/projects`                              | only when prompting on a TTY               |

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

| Variable                | Purpose                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | project-ref resolution (flag → env → TTY prompt)                                                                             |
| `SUPABASE_ACCESS_TOKEN` | Management API bearer auth (env → keyring → `~/.supabase/access-token`)                                                      |
| `SUPABASE_DB_PASSWORD`  | bound to `--password`; **accepted but a no-op** for `link` (the DB-connection path that would consume it is dead code in Go) |

## Exit Codes

| Code | Condition                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | success — project linked (incl. the 404 branch path); prints `Finished supabase link.`             |
| `1`  | non-TTY with no `--project-ref` / `SUPABASE_PROJECT_ID` (`required flag(s) "project-ref" not set`) |
| `1`  | malformed project ref                                                                              |
| `1`  | project paused (`INACTIVE`)                                                                        |
| `1`  | project status non-200/404                                                                         |
| `1`  | api-keys auth failure / missing key                                                                |
| `1`  | `project-ref` file write failure                                                                   |

> Best-effort service-link and telemetry errors never affect the exit code.

## Output

### `--output-format text` (Go-compatible)

- stderr: `Selected project: <ref>` (prompt path); `WARNING: Project status is <status> instead of Active Healthy. Some operations might fail.`; the dashboard unpause suggestion on a paused project.
- stdout: `Finished supabase link.`

### `--output-format json` / `stream-json`

Emits a structured success (`{ project_ref }`) and suppresses the human `Finished` line. Warnings still go to stderr.

## Known divergence

- The cosmetic `WARNING: Local database version differs from the linked project.` message (Go's
  `linkPostgresVersion`) is **not** reproduced: it requires loading the local `config.toml`
  `[db].major_version` with CLI defaults, which the legacy shell does not surface. The
  `postgres-version` file (the meaningful side effect) is still written.
- The `Finished supabase link.` line is emitted as **plain text**; Go renders `supabase link` in
  ANSI cyan via `utils.Aqua`. This matches the established legacy-port convention (color helpers are
  rendered plain); ANSI-stripping scripts are unaffected.
