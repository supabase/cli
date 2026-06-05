# `supabase bootstrap [template]`

`bootstrap` is a meta-orchestrator: it chains a workdir prompt → template fetch/download →
blank `init` → ensure-login → `projects create` → `projects api-keys` → `link` services →
health poll → write `.env` → `db push` → start suggestion. Every step is native TypeScript
**except** the migration push, which is delegated to the bundled Go binary (interim — see Notes).

## Files Read

| Path                                   | Format     | When                                                        |
| -------------------------------------- | ---------- | ----------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text | ensure-login token miss (env unset and keyring unavailable) |
| `<workdir>/.env.example`               | dotenv     | optional; merged into the generated `.env`                  |
| `<workdir>/supabase/.temp/project-ref` | plain text | read by the delegated `db push` subprocess (post-`chdir`)   |

## Files Written

| Path                                                                                                  | Format     | When                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                      | TOML       | blank/`scratch` path only (via `initProject`)                                                                                                                     |
| `<workdir>/<template files>`                                                                          | varies     | template path only (GitHub download)                                                                                                                              |
| `<workdir>/supabase/.temp/project-ref`                                                                | plain text | always (mandatory; fails the command on write error)                                                                                                              |
| `<workdir>/supabase/.temp/{pooler-url,rest-version,gotrue-version,storage-version,storage-migration}` | plain text | best-effort, from `link.LinkServices`                                                                                                                             |
| `<workdir>/.env`                                                                                      | dotenv     | best-effort (write failure prints a warning and continues)                                                                                                        |
| `<workdir>/supabase/.temp/linked-project.json`                                                        | JSON       | PersistentPostRun linked-project cache (`Effect.ensuring`); resolves against the bootstrap workdir (the prompted/`--workdir`/env target), not `cliConfig.workdir` |
| `~/.supabase/telemetry.json`                                                                          | JSON       | PersistentPostRun telemetry flush (`Effect.ensuring`)                                                                                                             |

**Process side effect:** `process.chdir(<workdir>)` mirrors Go's `ChangeWorkDir` and prints
`Using workdir <workdir>\n` to stderr (`workdir` bolded on a TTY). The original cwd is restored
in a finalizer so the delegated `db push` subprocess inherits the bootstrap workdir without
leaking the change to the surrounding process.

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
| db push routes  | —                                                                                         | —                              | fired by the **Go subprocess** (interim)                                                     |

## Environment Variables

| Variable                               | Purpose                                            | Required? |
| -------------------------------------- | -------------------------------------------------- | --------- |
| `SUPABASE_WORKDIR`                     | target dir (`--workdir` flag → env → prompt → cwd) | no        |
| `SUPABASE_DB_PASSWORD`                 | DB password (`-p` flag → env → prompt/generate)    | no        |
| `GITHUB_TOKEN`                         | raise the GitHub API rate limit for template fetch | no        |
| `SUPABASE_ACCESS_TOKEN`                | auth bypass for ensure-login                       | no        |
| `SUPABASE_API_URL`, `SUPABASE_PROFILE` | API host / profile                                 | no        |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                                                                                                        |
| `1`  | invalid template arg; overwrite declined (`context canceled`); template list/download failure; login failure; create failure; api-keys exhausted; health unhealthy / error status; db-push subprocess non-zero exit; any network failure. The `.env` derive/write is **non-fatal** (prints `Failed to create .env file: <err>` and continues). |

## Telemetry

- `cli_command_executed` — once (via `withLegacyCommandInstrumentation`).
- `cli_login_completed` — once, **only** on the browser-login path (token miss).
- **No `cli_project_linked`** — Go's `bootstrap` calls `link.LinkServices` (services only), **not**
  `link.Run`, so it deliberately skips the project-linked telemetry, status check, and the
  `linked-project.json` temp write that the standalone `link` command performs.
- `create` fires no custom event.
- db-push events are emitted by the **Go subprocess**, not the TS shell.

## Output

### `--output-format text` (Go-compatible)

stderr progress only: `Using workdir …`, `Created a new project at …`, `Linking project…`,
`Checking project health…`, and the final `To start your app:` suggestion (Aqua command lines).
`Downloading: <url>` goes to stdout (text mode only). The `create` sub-step also echoes the new
project per `-o` (`pretty|json|yaml|toml|env`); bootstrap adds no `-o` output of its own.

### `--output-format json` / `stream-json`

Human banners are suppressed; a single structured result is emitted:

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

- **Interim Go-proxy delegation for migration push.** The push step shells out to the bundled
  Go binary (`db push --include-roles --include-seed [--password …]`) until `db push` gets its
  own native port (separate Linear issue). The sub-step is **not** instrumentation-wrapped (the
  subprocess fires its own push telemetry). Known divergence: `LegacyGoProxy.exec` propagates the
  exit code, so Go's push backoff is **not** reproduced (single attempt) — to be restored when
  `db push` is natively ported. (`LegacyGoProxy.exec` exits the process on a non-zero exit rather
  than returning a failure, so the step cannot be wrapped in `Effect.retry`.)
- **Interim credential exposure.** Because the push step runs in a subprocess, the DB password is
  passed as `--password <value>` and is therefore briefly visible in the OS process table for the
  lifetime of that subprocess (Go runs `push.Run` in-process and never exposes it). The same
  password is already written in plaintext to `<workdir>/.env` in the same directory, so the
  incremental exposure is small; it is eliminated when `db push` is natively ported (no subprocess).
- The api-keys and health retries use the full Go `utils.NewBackoffPolicy` policy: exponential
  backoff, 3s initial interval, multiplier 1.5, 60s max interval (capped before jitter), ±50% jitter
  (randomization factor 0.5), 15m max-elapsed cap, and 8 retries (9 total attempts). The per-attempt
  `Linking project…` / `Checking project health…` lines are reproduced, **and** Go's
  `NewErrorCallback` notice — `<err>\nRetry (n/8): ` after each failed attempt — is reproduced:
  failures 1-2 go to the debug logger (shown only under `--debug`), failures 3+ to stderr; the final
  exhausted attempt prints no notice (matches `backoff.RetryNotify`).
- `Downloading:` / progress banners are gated to text mode to keep machine stdout payload-only
  (CLI-1546).
