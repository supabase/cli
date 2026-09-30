# `supabase services`

## Files Read

| Path                                                 | Format        | When                                                                                             |
| ---------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `supabase/.temp/project-ref`                         | plain text    | when the checkout is linked and no explicit ref is already loaded                                |
| `supabase/config.toml` and project environment files | TOML / dotenv | legacy service overrides, linked remote config, or stack PostgreSQL major selection              |
| Docker client context/config metadata                | JSON          | when the shared local project context resolves the Docker hostname; no daemon connection is made |
| `~/.supabase/access-token`                           | plain text    | when `SUPABASE_ACCESS_TOKEN` is unset and keyring access falls back to the home token file       |

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

| Variable                      | Purpose                                                                                                                                                                                                                                                                                       | Required?                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`       | auth token for Management API linked-version checks                                                                                                                                                                                                                                           | no (falls back to keyring, then `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`            | built-in profile name or YAML file path                                                                                                                                                                                                                                                       | no (falls back to `~/.supabase/profile` -> `supabase`)      |
| `SUPABASE_USE_SLIM_IMAGES`    | Ambient `process.env` only (`true`/`1` enable). Rewrites legacy current-pin `SERVICE IMAGE`/`name` fields to `ghcr.io/supabase/cli/<service>`; Kong stays on docker.io. Majors 13/15 list the slim `15.14.1.167` pin when enabled; flag-off keeps `15.8.1.085`. Ignored by the stack backend. | no                                                          |
| `SUPABASE_EXPERIMENTAL_STACK` | Selects the stack backend (`1`) or legacy backend (`0`); unset or empty uses `experimental.stack`. Other values fail routing.                                                                                                                                                                 | no                                                          |
| `SUPABASE_DB_MAJOR_VERSION`   | Stack backend PostgreSQL major override; supported values are 15 and 17.                                                                                                                                                                                                                      | no                                                          |

## Exit Codes

| Code | Condition                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | success; always prints the local service matrix and optionally linked versions       |
| `1`  | `--output env` is unsupported, or `SUPABASE_EXPERIMENTAL_STACK` has an invalid value |

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

- Backend selection follows canonical experimental-feature routing: `SUPABASE_EXPERIMENTAL_STACK=1|0` takes precedence over `experimental.stack`; unset or empty uses project config, and an invalid environment value fails. Output fields and serializers stay the same.
- The legacy backend uses its baked-in service matrix and honors its existing config/version overrides. The stack backend lists services from the installed CLI artifact catalog using canonical `ghcr.io/supabase/cli/...` image names and catalog versions. Native and Docker runtimes use the same catalog versions. Since the catalog belongs to the installed CLI, an older launched CLI or a newer/mirrored stack image may differ from this inventory. The command does not inspect running containers, image pulls, service health, or live stack state.
- For stack mode, PostgreSQL uses the configured major version or `SUPABASE_DB_MAJOR_VERSION` (15 or 17). Invalid configuration or an unsupported PostgreSQL major warns with the cause and falls back to default catalog versions; absent config uses defaults. Legacy image pins, slim-image rewriting, and remote image overrides do not affect stack results.
- Linked-version checks are best-effort. Remote lookup failures do not change the exit code; they only leave the `LINKED` column empty for unavailable services.
- A malformed linked ref is the one lookup failure that prints an explicit stderr warning (see API Routes above); every other remote failure (network error, expired token, etc.) still fails silently and just leaves `LINKED` empty. Most real-world malformed refs come from an untrimmed `SUPABASE_PROJECT_ID` env var (e.g. a trailing newline from a secrets manager or `.env` file) rather than actual file tampering — the env var is read raw and unlike the on-disk `project-ref` file is never trimmed.
- Version mismatches are reported to stderr as a warning. In stack mode, the warning explains that catalog versions cannot be changed with `supabase link`.
- `telemetry.json` is written on every invocation, including `--output env` failures.
