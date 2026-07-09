# `supabase status`

## Files Read

| Path                                                                                                                | Format    | When                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                                                                    | TOML      | always, to resolve project configuration                                      |
| `auth.signing_keys_path` (config-relative or absolute)                                                              | JSON      | only when `auth.signing_keys_path` is set in config.toml                      |
| `api.tls.cert_path` / `api.tls.key_path` (unconditionally joined with `<workdir>/supabase`, no absolute-path guard) | raw bytes | only when `api.enabled` and `api.tls.enabled`, and the respective path is set |

## Files Written

| Path                         | Format | When   |
| ---------------------------- | ------ | ------ |
| `~/.supabase/telemetry.json` | JSON   | always |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Neither this command nor any of its dependencies make a Management API call — everything is
resolved from local `config.toml` and the local Docker daemon.

## Environment Variables

| Variable                         | Purpose                                                 | Required?                                                               |
| -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`            | overrides the resolved local project id                 | no (falls back to config.toml `project_id` → workdir basename)          |
| `SUPABASE_WORKDIR`               | overrides the resolved project workdir                  | no (falls back to `--workdir` → walk-up search for `config.toml` → cwd) |
| `SUPABASE_SERVICES_HOSTNAME`     | overrides the hostname used to build local service URLs | no (falls back to `DOCKER_HOST`'s tcp host → `127.0.0.1`)               |
| `SUPABASE_AUTH_JWT_SECRET`       | overrides `auth.jwt_secret`                             | no                                                                      |
| `SUPABASE_AUTH_PUBLISHABLE_KEY`  | overrides `auth.publishable_key`                        | no                                                                      |
| `SUPABASE_AUTH_SECRET_KEY`       | overrides `auth.secret_key`                             | no                                                                      |
| `SUPABASE_AUTH_ANON_KEY`         | overrides `auth.anon_key`                               | no                                                                      |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY` | overrides `auth.service_role_key`                       | no                                                                      |

The `SUPABASE_AUTH_*` vars mirror Go's Viper `AutomaticEnv` (`SetEnvPrefix("SUPABASE")` +
`.`→`_` key replacer, `pkg/config/config.go:529-535`) and take precedence over the corresponding
`config.toml` value, matching Viper's real precedence order.

`docker` (or `podman` as a fallback) must be on `PATH`.

## Exit Codes

| Code | Condition                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | success — status displayed                                                                                                                                   |
| `0`  | **`--ignore-health-check` is set** — skips the health assertion below entirely, so an unhealthy/not-running db never fails the command                       |
| `1`  | `supabase/config.toml` missing or malformed                                                                                                                  |
| `1`  | a malformed `--override-name` entry                                                                                                                          |
| `1`  | listing running containers failed (Docker daemon unreachable, etc.)                                                                                          |
| `1`  | the db container inspect call failed (including "not found") — health assertion, skipped by `--ignore-health-check` above                                    |
| `1`  | the db container is present but not in the `running` state — health assertion, skipped by `--ignore-health-check` above                                      |
| `1`  | the db container is running but its Docker health check isn't `healthy` — health assertion, skipped by `--ignore-health-check` above                         |
| `1`  | `auth.jwt_secret` is configured but shorter than 16 characters (Go's `Config.Validate` rejects this at config-load time)                                     |
| `1`  | `auth.signing_keys_path` is configured but the file is missing/malformed, or its first key's algorithm is not `RS256`/`ES256`                                |
| `1`  | `api.enabled` and `api.tls.enabled` are true and only one of `api.tls.cert_path`/`key_path` is set (Go's `Config.Validate` rejects this at config-load time) |
| `1`  | `api.enabled` and `api.tls.enabled` are true, both `cert_path` and `key_path` are set, but one of the files can't be read                                    |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` (Go CLI compatible)

Default (`-o` unset or `-o pretty`): a stderr banner, then 5 grouped rounded-border tables on
stdout. Empty rows (a value with nothing resolved) and entirely empty groups are skipped; a
blank line follows every group, rendered or not.

```
supabase local development setup is running.

╭──────────────────────────────────────╮
│ 🔧 Development Tools                 │
├─────────┬────────────────────────────┤
│ Studio  │ http://127.0.0.1:54323     │
│ Mailpit │ http://127.0.0.1:54324     │
│ MCP     │ http://127.0.0.1:54321/mcp │
╰─────────┴────────────────────────────╯

╭──────────────────────────────────────────────────────╮
│ 🌐 APIs                                              │
├────────────────┬─────────────────────────────────────┤
│ Project URL    │ http://127.0.0.1:54321              │
│ REST           │ http://127.0.0.1:54321/rest/v1      │
│ GraphQL        │ http://127.0.0.1:54321/graphql/v1   │
│ Edge Functions │ http://127.0.0.1:54321/functions/v1 │
╰────────────────┴─────────────────────────────────────╯

╭───────────────────────────────────────────────────────────────╮
│ ⛁ Database                                                    │
├─────┬─────────────────────────────────────────────────────────┤
│ URL │ postgresql://postgres:postgres@127.0.0.1:54322/postgres │
╰─────┴─────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────╮
│ 🔑 Authentication Keys                                       │
├─────────────┬────────────────────────────────────────────────┤
│ Publishable │ sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH │
│ Secret      │ sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz      │
╰─────────────┴────────────────────────────────────────────────╯

╭───────────────────────────────────────────────────────────────────────────────╮
│ 📦 Storage (S3)                                                               │
├────────────┬──────────────────────────────────────────────────────────────────┤
│ URL        │ http://127.0.0.1:54321/storage/v1/s3                             │
│ Access Key │ 625729a08b95bf1b7ff351a663f3a23c                                 │
│ Secret Key │ 850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907 │
│ Region     │ local                                                            │
╰────────────┴──────────────────────────────────────────────────────────────────╯
```

Group table cells are colored on a TTY (Aqua for links, Yellow for keys, Green for labels, bold
headers); colors are stripped on non-TTY/piped output.

`Stopped services: [<container-id> ...]` is written to stderr (Go slice format, e.g.
`[supabase_storage_test supabase_studio_test]`) whenever one of the 13 expected service
containers isn't in the running set.

### `-o env`

`KEY="VALUE"` lines (unquoted for integer-looking values), one per resolved field, sorted by
key — see `legacy-go-output.encoders.ts`'s `encodeEnv`.

### `-o json`

```json
{
  "API_URL": "http://127.0.0.1:54321",
  "DB_URL": "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  "ANON_KEY": "...",
  "SERVICE_ROLE_KEY": "...",
  "PUBLISHABLE_KEY": "...",
  "SECRET_KEY": "...",
  "JWT_SECRET": "...",
  "S3_PROTOCOL_ACCESS_KEY_ID": "625729a08b95bf1b7ff351a663f3a23c",
  "S3_PROTOCOL_ACCESS_KEY_SECRET": "...",
  "S3_PROTOCOL_REGION": "local"
}
```

Top-level keys sorted alphabetically, 2-space indent, trailing newline (Go `encoding/json`
parity). Fields whose owning service is disabled or excluded are omitted entirely (not emitted
as `null`/`""`).

### `-o yaml` / `-o toml`

Same value set as `-o json`, encoded via `encodeYaml`/`encodeToml`.

### `--output-format json` / `stream-json` (when `-o` is unset or `pretty`)

Additive — no Go CLI equivalent. Emits the same resolved value map via
`output.success("", values)` / the NDJSON `result` event.

## Notes

- `-o`/`--output` (`env|pretty|json|toml|yaml`) takes priority over `--output-format` whenever
  it is set, matching the Go-parity checklist's dual-output-flag rule. `-o pretty` (or `-o`
  unset) falls through to `--output-format`'s text/json/stream-json handling.
- `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` remaps a single field's output KEY; the
  value and group layout are unaffected. An unknown key or a malformed (non `KEY=VALUE`) entry
  fails with `LegacyStatusOverrideParseError`. This only affects the `env`/`json`/`toml`/`yaml`
  (`printStatus`) output path — matching Go, the pretty table (`-o pretty` or unset) always
  renders with un-overridden names, since Go's `PrettyPrint` unmarshals a fresh, empty `EnvSet{}`
  rather than reusing the CLI-supplied, override-populated `CustomName` (`status.go:236-243`).
- When neither `docker` nor `podman` can be spawned at all, the error message names the actual
  root cause (e.g. "docker: command not found (podman also not found) — install Docker Desktop or
  Podman and ensure it is on PATH") rather than a generic "failed to ..." string.
- `--exclude <value>` (hidden) omits a service from the value map when `value` matches either its
  container id or its default Docker image short name (Go's `ShortContainerImageName`, e.g.
  `storage-api` for the storage service, `edge-runtime` for edge functions) — the default image
  is read from the same embedded Dockerfile manifest Go parses, so a version bump there is picked
  up automatically without needing to read the `.temp/<service>-version` pin file.
- `--ignore-health-check` (hidden) skips the db container health assertion entirely and always
  exits `0`, matching Go's early-return in `Run()`.
- Default `auth.anon_key`/`auth.service_role_key`/`auth.jwt_secret` values are generated via a
  Go-byte-exact HS256 signer (`legacy-go-jwt.ts`), not `@supabase/stack`'s `generateJwt` — the
  latter uses a different issuer, expiry, and claim order that would not match what Go prints
  for local dev keys. A configured `auth.jwt_secret` shorter than 16 characters fails the command
  (`LegacyStatusInvalidConfigError`), matching Go's `Config.Validate` rejecting it at config-load
  time before any command can render output.
- When `auth.signing_keys_path` is set and resolves to a non-empty JWK array, `anon_key`/
  `service_role_key` are instead signed asymmetrically (RS256/ES256) with the file's first key,
  matching Go's `generateJWT` (`pkg/config/apikeys.go:76-113`) — a relative path resolves against
  `<workdir>/supabase`. This path is skipped entirely when `auth.anon_key`/`auth.service_role_key`
  are explicitly configured. A missing/malformed file, or a first key with an algorithm other than
  `RS256`/`ES256`, fails the command (`LegacyStatusInvalidConfigError`).
- `SUPABASE_AUTH_JWT_SECRET`/`SUPABASE_AUTH_PUBLISHABLE_KEY`/`SUPABASE_AUTH_SECRET_KEY`/
  `SUPABASE_AUTH_ANON_KEY`/`SUPABASE_AUTH_SERVICE_ROLE_KEY` override the corresponding
  `config.toml` value at higher precedence, matching Go's Viper `AutomaticEnv` — an empty env var
  is treated as unset. This is scoped to exactly the 5 auth fields `status` reads; it is not a
  general `@supabase/config` port of Viper's `AutomaticEnv` (which applies to every config field).
- `db.password` and the `storage.s3_credentials` triple have no `@supabase/config` schema field;
  Go hardcodes both (`"postgres"` and the S3 access key/secret/region seen above), reproduced
  identically in `legacy-local-config-values.ts`.
- No e2e test is planned for this command: there is no Docker-daemon-free golden path, and the
  e2e harness (`runSupabase()`) does not provision a real local stack. This is a scope reduction
  relative to the Linear issue's "E2E compatibility test added" checkbox; see the port plan for
  the full justification.
