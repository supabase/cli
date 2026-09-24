# `supabase services`

## Files Read

| Path                                                                                               | Format       | When                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json` or `config.toml`                                                  | JSON or TOML | backend routing before command parsing when `SUPABASE_EXPERIMENTAL_STACK` is unset or empty; JSON takes precedence when both exist                                                                                      |
| `<workdir>/supabase/config.toml`                                                                   | TOML         | always; legacy merges the linked ref's `[remotes.<name>]` block and prints a load error to stderr before falling back to the default matrix, while the stack applies no remotes merge and fails on a config error       |
| `<workdir>/supabase/` and project-root dotenv files                                                | dotenv       | always; `.env.<SUPABASE_ENV>.local`, `.env.local` (skipped when `SUPABASE_ENV=test`), `.env.<SUPABASE_ENV>`, `.env`, with `SUPABASE_ENV` defaulting to `development`; `supabase/` values win over the project root      |
| `auth.signing_keys_path` file, `auth.email.template.*` / `auth.email.notification.*` content files | JSON / text  | legacy only, when configured and `auth.enabled` (config validation); stack mode never reads them, ignores `auth.signing_keys_path`, and fails on a template or enabled notification `content_path` while `auth.enabled` |
| `<workdir>/supabase/.temp/pooler-url`                                                              | plain text   | legacy only, when present; does not affect the output                                                                                                                                                                   |
| `<workdir>/supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version`    | plain text   | legacy only, when present; `gotrue`/`rest` only when `db.major_version` is above 14                                                                                                                                     |
| `<workdir>/supabase/.temp/postgres-version`                                                        | plain text   | legacy only, when `db.major_version` is above 14 and `experimental.orioledb_version` is unset                                                                                                                           |
| `<workdir>/supabase/.temp/edge-runtime-version`                                                    | plain text   | legacy only, unless `edge_runtime.deno_version = 1`                                                                                                                                                                     |
| `supabase/.temp/project-ref`                                                                       | plain text   | when the checkout is linked and no explicit ref is already loaded                                                                                                                                                       |
| `~/.supabase/access-token`                                                                         | plain text   | when `SUPABASE_ACCESS_TOKEN` is unset and keyring access falls back to the home token file                                                                                                                              |

## Files Written

| Path                                 | Format | When                                                                                                   |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `supabase/.temp/linked-project.json` | JSON   | when a project ref resolves and no cache exists yet (`Effect.ensuring(linkedProjectCache.cache(ref))`) |
| `~/.supabase/telemetry.json`         | JSON   | always (`Effect.ensuring(telemetryState.flush)`) at end of the command                                 |

## API Routes

**Handling of a malformed ref:** the resolved ref is validated against
`^[a-z]{20}$`. The old Go CLI only warned on failure and still called the remote
lookup with the malformed ref anyway. This port prints the same warning
("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.") but
deliberately skips the remote lookup instead of reproducing that behavior — the
ref is embedded unescaped into the tenant gateway hostname below, so proceeding
with a malformed value would let it redirect the service-role key to an
attacker-controlled host. Only the local matrix is printed in this case. This
is intentional TS-only hardening, not a parity bug.

Tenant calls send `apikey: <serviceKey>` and additionally
`Authorization: Bearer <serviceKey>` unless the key is a new-style `sb_…` key
(which authenticates via the `apikey` header alone).

| Method | Path                                           | Auth                           | Request body | Response (used fields)                                             |
| ------ | ---------------------------------------------- | ------------------------------ | ------------ | ------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token                   | none         | `{ref, name, region, status, organization_slug, database.version}` |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true`      | Bearer token                   | none         | `[{name, type, api_key, secret_jwt_template}]`                     |
| `GET`  | `https://{ref}.supabase.co/auth/v1/health`     | apikey (+ Bearer if non-`sb_`) | none         | `{version}`                                                        |
| `GET`  | `https://{ref}.supabase.co/rest/v1/`           | apikey (+ Bearer if non-`sb_`) | none         | `{info.version}`                                                   |
| `GET`  | `https://{ref}.supabase.co/storage/v1/version` | apikey (+ Bearer if non-`sb_`) | none         | plain text version body                                            |

## Environment Variables

| Variable                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                  | Required?                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`       | auth token for Management API linked-version checks                                                                                                                                                                                                                                                                                                                                                      | no (falls back to keyring, then `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`            | built-in profile name or YAML file path                                                                                                                                                                                                                                                                                                                                                                  | no (falls back to `~/.supabase/profile` -> `supabase`)      |
| `SUPABASE_EXPERIMENTAL_STACK` | `1`/`0` overrides `[experimental] stack`. With the stack selected, the project config is validated like `start`, local rows come from the stack artifact catalog (`ghcr.io/supabase/cli/<service>`), `[remotes.*]` overrides, `supabase/.temp` version pins and `SUPABASE_USE_SLIM_IMAGES` are ignored, and the mismatch warning notes that `supabase link` does not change the stack's pinned versions. | no                                                          |
| `SUPABASE_USE_SLIM_IMAGES`    | Ambient `process.env` only (`true`/`1` enable). Rewrites current-pin `SERVICE IMAGE`/`name` fields to `ghcr.io/supabase/cli/<service>`. Kong stays on docker.io. Majors 13/15 list the slim `15.14.1.167` pin when the flag is on; flag-off keeps `15.8.1.085`.                                                                                                                                          | no                                                          |

## Exit Codes

| Code | Condition                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | success; always prints the local service matrix and optionally linked versions                           |
| `1`  | `--output env` is requested; explicitly unsupported                                                      |
| `1`  | the stack is selected and the project config fails the experimental stack's validation (same as `start`) |
| `1`  | `SUPABASE_EXPERIMENTAL_STACK` has an invalid value                                                       |

## Output

### Default / text

Prints a Markdown table with `SERVICE IMAGE`, `LOCAL`, and `LINKED` columns.

### `--output json`

Prints the JSON array of service rows.

### `--output toml`

Prints a TOML object with a top-level `services = [...]` array.

### `--output yaml`

Prints the YAML array of service rows.

### `--output-format json`

TS-only structured success event: `{ services: [...] }`.

### `--output-format stream-json`

TS-only NDJSON success event with the same `{ services: [...] }` payload.

## Notes

- Local versions come from the command's baked-in service matrix plus `config.toml` and `supabase/.temp` pins (legacy), or from the stack artifact catalog (experimental stack); the command does not inspect Docker state.
- Linked-version checks are best-effort. Remote lookup failures do not change the exit code; they only leave the `LINKED` column empty for unavailable services.
- A malformed linked ref is the one lookup failure that prints an explicit stderr warning (see API Routes above); every other remote failure (network error, expired token, etc.) still fails silently and just leaves `LINKED` empty. Most real-world malformed refs come from an untrimmed `SUPABASE_PROJECT_ID` env var (e.g. a trailing newline from a secrets manager or `.env` file) rather than actual file tampering — the env var is read raw and unlike the on-disk `project-ref` file is never trimmed.
- Version mismatches are reported to stderr as a warning.
- `telemetry.json` is written on every invocation, including `--output env` failures.
