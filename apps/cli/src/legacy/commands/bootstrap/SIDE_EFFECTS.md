# `supabase bootstrap [template]`

`bootstrap` is a meta-orchestrator: it chains a workdir prompt → template fetch/download →
blank `init` → ensure-login → `projects create` → `projects api-keys` → `link` services →
health poll → write `.env` → `db push` → start suggestion. Every step is native TypeScript,
including the migration push (`legacyDbPushCore`, shared with the standalone `supabase db push`
command — see Notes).

## Files Read

| Path                                            | Format     | When                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                      | plain text | ensure-login token miss (env unset and keyring unavailable)                                                                                                                                                                                                          |
| `<workdir>/.env.example`                        | dotenv     | optional; merged into the generated `.env`                                                                                                                                                                                                                           |
| `<workdir>/supabase/config.toml`                | TOML       | native push step (embedded defaults used when absent)                                                                                                                                                                                                                |
| `<workdir>/supabase/.temp/pooler-url`           | plain text | native push step's connection resolution, only when the direct `db.<ref>.<projectHost>:5432` host is unreachable (IPv4-only network) — `legacyResolveLinkedConn` falls back through the saved pooler URL `link.LinkServices` wrote in the earlier link-services step |
| `<workdir>/supabase/migrations/`                | directory  | native push step, when `[db.migrations].enabled` (default true)                                                                                                                                                                                                      |
| `<workdir>/supabase/migrations/*.sql`           | SQL        | native push step, for each pending migration applied                                                                                                                                                                                                                 |
| seed files from `[db.seed].sql_paths`           | SQL        | native push step (`--include-seed` is always set; gated on `[db.seed].enabled`)                                                                                                                                                                                      |
| `<workdir>/supabase/roles.sql`                  | SQL        | native push step (`--include-roles` is always set; existence check + apply)                                                                                                                                                                                          |
| `<workdir>/supabase/.temp/edge-runtime-version` | plain text | native push step's migrations-catalog cache (pg-delta), when a pinned edge-runtime image tag exists — resolved against the bootstrap workdir explicitly, not `cliConfig.workdir` (which is stale after this handler's own `process.chdir`)                           |

## Files Written

| Path                                                                                                  | Format     | When                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                      | TOML       | blank/`scratch` path only (via `initProject`)                                                                                                                     |
| `<workdir>/<template files>`                                                                          | varies     | template path only (GitHub download)                                                                                                                              |
| `<workdir>/supabase/.temp/project-ref`                                                                | plain text | always (mandatory; fails the command on write error)                                                                                                              |
| `<workdir>/supabase/.temp/{pooler-url,rest-version,gotrue-version,storage-version,storage-migration}` | plain text | best-effort, from `link.LinkServices`                                                                                                                             |
| `<workdir>/.env`                                                                                      | dotenv     | best-effort (write failure prints a warning and continues)                                                                                                        |
| `<workdir>/supabase/.temp/pgdelta/catalog-<prefix>-migrations-<hash>-<ts>.json`                       | JSON       | native push step, best-effort, after a successful migration apply, when pg-delta is enabled (a failure only warns on stderr and never fails the push)             |
| `<workdir>/supabase/.temp/pgdelta/pgdelta-target-ca.crt`                                              | PEM        | native push step, same pg-delta gate, when the target requires SSL                                                                                                |
| `<workdir>/supabase/.temp/linked-project.json`                                                        | JSON       | PersistentPostRun linked-project cache (`Effect.ensuring`); resolves against the bootstrap workdir (the prompted/`--workdir`/env target), not `cliConfig.workdir` |
| `~/.supabase/telemetry.json`                                                                          | JSON       | PersistentPostRun telemetry flush (`Effect.ensuring`)                                                                                                             |

**Process side effect:** `process.chdir(<workdir>)` mirrors Go's `ChangeWorkDir` and prints
`Using workdir <workdir>\n` to stderr (`workdir` bolded on a TTY). The original cwd is restored
in a finalizer once the command returns — every step, including the native push, reads its own
explicit `workdir` local variable rather than `process.cwd()`, so nothing depends on the chdir
staying in effect.

## API Routes

| Method          | Path                                                                                      | Auth                           | Notes                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `GET`           | `api.github.com/repos/supabase-community/supabase-samples/contents/samples.json?ref=main` | optional `Bearer GITHUB_TOKEN` | base64 `content` → `{samples:[…]}`                                                           |
| `GET`           | `api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>` + raw `download_url`      | optional `Bearer GITHUB_TOKEN` | template download (BFS, concurrency 5)                                                       |
| `GET`           | `/v1/organizations`                                                                       | Bearer                         | interactive org picker (create core)                                                         |
| `POST`          | `/v1/projects`                                                                            | Bearer                         | `{name, organization_slug, db_pass, region?, desired_instance_size?, template_url?}` → `201` |
| `GET`           | `/v1/projects/{ref}/api-keys`                                                             | Bearer                         | retried with exponential backoff (no `reveal`)                                               |
| `GET`           | `/v1/projects/{ref}` + storage/pooler config + tenant version probes                      | Bearer / service key           | `link.LinkServices` (best-effort)                                                            |
| `GET`           | `/v1/projects/{ref}/health?services=db`                                                   | Bearer                         | retried with exponential backoff                                                             |
| login endpoints | —                                                                                         | —                              | ensure-login browser flow (token miss)                                                       |

The native push step fires **no Management API routes of its own**. Its connection is resolved
separately from (not reused from) the naive one written to `.env` above: `legacyResolveLinkedConn`
dials the direct `db.<ref>.<projectHost>:5432` host first and, only when that's unreachable, falls
back to the project's IPv4 transaction pooler via the saved `<workdir>/supabase/.temp/pooler-url`
(no Management API fetch — bootstrap's create step already guarantees a non-empty password, so
neither branch ever reaches the temp-login-role/Management-API path a passwordless resolve would).

## Environment Variables

| Variable                           | Purpose                                                                                                                 | Required? |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_WORKDIR`                 | target dir (`--workdir` flag → env → prompt → cwd)                                                                      | no        |
| `SUPABASE_DB_PASSWORD`             | DB password (`-p` flag → env → prompt/generate)                                                                         | no        |
| `GITHUB_TOKEN`                     | raise the GitHub API rate limit for template fetch                                                                      | no        |
| `SUPABASE_ACCESS_TOKEN`            | auth bypass for ensure-login                                                                                            | no        |
| `SUPABASE_PROFILE`                 | profile name/path (env → `~/.supabase/profile` → `supabase`)                                                            | no        |
| `SUPABASE_YES`                     | auto-confirm the native push step's prompts (Go's viper `YES`), read project-`.env`-aware like the standalone `db push` | no        |
| `SUPABASE_EXPERIMENTAL_PG_DELTA`   | enables the push step's migrations-catalog cache when `[experimental.pgdelta].enabled` is unset                         | no        |
| `SUPABASE_INTERNAL_IMAGE_REGISTRY` | overrides the push step's pg-delta edge-runtime image registry                                                          | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | success                                                                                                                                                                                                                                                                                                                                                                                                            |
| `1`  | invalid template arg; overwrite declined (`context canceled`); template list/download failure; login failure; create failure; api-keys exhausted; health unhealthy / error status; native push failure (missing local/remote migrations, cancelled confirmation, connect/apply failure); any network failure. The `.env` derive/write is **non-fatal** (prints `Failed to create .env file: <err>` and continues). |

## Telemetry

- `cli_command_executed` — once (via `withLegacyCommandInstrumentation`).
- `cli_login_completed` — once, **only** on the browser-login path (token miss).
- **No `cli_project_linked`** — Go's `bootstrap` calls `link.LinkServices` (services only), **not**
  `link.Run`, so it deliberately skips the project-linked telemetry, status check, and the
  `linked-project.json` temp write that the standalone `link` command performs.
- `create` fires no custom event.
- The native push step (`legacyDbPushCore`) fires **no telemetry of its own** — it is the bare
  handler function, not `db push`'s own `push.command.ts` wrapper (the thing that fires
  `withLegacyCommandInstrumentation` for the standalone command), so there is no risk of a second
  `cli_command_executed` for one `bootstrap` invocation.

## Output

### `--output-format text` (Go-compatible)

stderr progress: `Using workdir …`, `Created a new project at …`, `Linking project…`,
`Checking project health…`, the native push step's own progress (`Connecting to remote
database…`, `Applying migration …`, `Seeding…`, skip/up-to-date notices, confirmation prompts —
byte-identical to the standalone `db push`, see its own `SIDE_EFFECTS.md`), and the final
`To start your app:` suggestion (Aqua command lines). `Downloading: <url>` goes to stdout (text
mode only). The `create` sub-step also echoes the new project per `-o`
(`pretty|json|yaml|toml|env`); bootstrap adds no `-o` output of its own. The push step's own
stdout summary line (`<Target> is up to date.` / `Finished supabase db push.`) also prints in
text mode, matching Go (`push.Run` prints it unconditionally, whether called from the `db push`
command or from `bootstrap`).

### `--output-format json` / `stream-json`

Human banners — including the native push step's own stdout summary line and any
`--output-format` structured result it would otherwise emit (`emitStructuredResult: false`) — are
suppressed; a single structured result is emitted for the whole command:

```json
{
  "workdir": "…",
  "project_ref": "…",
  "template": "scratch",
  "start_command": "supabase start",
  "env_file": "…/.env"
}
```

## Notes

- **Native migration push, sharing `db push`'s own core (CLI-1953).** The push step calls
  `legacyDbPushCore` — the same handler `db push`'s own command extracts its business logic into
  — directly with `{ includeAll: false, includeRoles: true, includeSeed: true, dryRun: false }`,
  matching Go's `push.Run(ctx, false, false, true, true, config, fsys)` (`bootstrap.go:122-127`).
  Go's bootstrap never re-resolves the project ref for push: `create.Run` already set
  `flags.ProjectRef`, reused as-is. The TS port mirrors this for `workdir`/`projectRef` (passed as
  plain values, never re-derived via `LegacyProjectRefResolver`, which keys off
  `LegacyCliConfig.workdir`, stale after this handler's own `process.chdir` — see the workdir
  comments in `bootstrap.handler.ts`). The **connection** itself, however, is resolved via its own
  `legacyResolveLinkedConn` call — Go's `flags.NewDbConfigWithPassword` dial-direct/pooler-fallback
  logic — not reused from the naive `deriveDbConfig(...)` connection already written to `.env`
  above: an IPv6-only direct host would otherwise burn all 9 push retries before falling back (see
  the connection-resolution bullet below). `LegacyDbConfigResolver` is still skipped (it keys off
  the same stale `LegacyCliConfig.workdir`). This is proven under test in
  `bootstrap.workdir-cache.integration.test.ts`, which seeds a migration file at the _prompted_
  bootstrap workdir (divergent from `cliConfig.workdir`'s cwd-walk result) and asserts the push
  step still finds and applies it.
- **Connection resolution**: the native push step's connection comes from `legacyResolveLinkedConn`
  (shared with `db push`/`db pull`'s own `--linked` resolution), which dials the direct
  `db.<ref>.<projectHost>:5432` host first and transparently falls back to the project's IPv4
  transaction pooler (reading the saved `<workdir>/supabase/.temp/pooler-url`, see Files Read)
  when that host is unreachable — new Supabase projects commonly have an IPv6-only direct host, so
  this fallback is the common case on an IPv4-only network. The resolved connection also carries
  the active profile's `suggestionContext` (dashboard URL + profile name), so a connect failure
  during the push still renders Go's `SetConnectSuggestion` hint (Network Restrictions / wrong
  password / IPv6 / wrong profile) instead of falling back to the generic `--debug` suggestion.
  When resolution itself fails because the direct host is unreachable and no pooler URL was ever
  saved (`LegacyDbConfigIpv6Error`), Go's `NewDbConfigWithPassword` (`db_url.go:161-163`) logs the
  error and presses on with its best-effort direct-host config rather than aborting
  (`bootstrap.go:115-118`); this is matched by catching that one error, logging it to stderr, and
  falling back to the same direct-host shape already computed for `.env` (step K's `dbConfig`) so
  the retry-wrapped push below still gets real reconnect attempts across the backoff window instead
  of failing bootstrap immediately.
- **Password**: Go's bootstrap never forwards a password to its internal push call on a separate
  channel — it always reuses the create-resolved password (`created.dbPassword`). There is no
  flag-vs-env distinction to preserve once the call is in-process (unlike the former Go-subprocess
  delegation, CLI-1617, which had to route the resolved password across process boundaries).
- **Retry**: the native push step is wrapped in the same `legacyBootstrapRetryNotify()` +
  `Effect.retry(retry)` policy as the api-keys and health-poll steps, matching Go's
  `policy.Reset()` + `backoff.RetryNotify` wrap around `push.Run` (`bootstrap.go:122-127`). A
  retried attempt re-runs the whole push (connect, list pending migrations/seeds/roles, prompt,
  apply) — Go does the same, since `backoff.RetryNotify` re-invokes the given function verbatim.
- The api-keys, health, and push retries use the full Go `utils.NewBackoffPolicy` policy:
  exponential backoff, 3s initial interval, multiplier 1.5, 60s max interval (capped before
  jitter), ±50% jitter (randomization factor 0.5), 15m max-elapsed cap, and 8 retries (9 total
  attempts). The per-attempt `Linking project…` / `Checking project health…` lines are
  reproduced (the push step has no such per-attempt line — Go doesn't print one either, relying
  on push's own internal progress messages), **and** Go's `NewErrorCallback` notice —
  `<err>\nRetry (n/8): ` after each failed attempt — is reproduced: failures 1-2 go to the debug
  logger (shown only under `--debug`), failures 3+ to stderr; the final exhausted attempt prints
  no notice (matches `backoff.RetryNotify`).
- `Downloading:` / progress banners are gated to text mode to keep machine stdout payload-only
  (CLI-1546).
