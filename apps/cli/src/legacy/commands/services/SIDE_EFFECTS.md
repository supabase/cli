# `supabase services`

## Files Read

| Path                         | Format     | When                                                                                       |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `supabase/.temp/project-ref` | plain text | when the checkout is linked and no explicit ref is already loaded                          |
| `~/.supabase/access-token`   | plain text | when `SUPABASE_ACCESS_TOKEN` is unset and keyring access falls back to the home token file |

## Files Written

| Path                                 | Format | When                                                                                                                                             |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/.temp/linked-project.json` | JSON   | when a project ref resolves and no cache exists yet (`Effect.ensuring(linkedProjectCache.cache(ref))`, mirrors Go's `ensureProjectGroupsCached`) |
| `~/.supabase/telemetry.json`         | JSON   | always (`Effect.ensuring(telemetryState.flush)`) at end of the command                                                                           |

## API Routes

**Divergence from Go on a malformed ref:** Go validates the resolved ref against
`utils.ProjectRefPattern` (`^[a-z]{20}$`) but only warns on failure
(`cmd/services.go`'s `Run` prints the validation error to stderr) and still
calls `listRemoteImages` with the malformed ref anyway (`services.go:61-62`).
TS prints the same warning ("Invalid project ref format. Must be like
`abcdefghijklmnopqrst`.") but deliberately skips the remote lookup instead of
reproducing Go's behavior — the ref is embedded unescaped into the tenant
gateway hostname below, so proceeding with a malformed value would let it
redirect the service-role key to an attacker-controlled host. Only the local
matrix is printed in this case. This is intentional TS-only hardening, not a
parity bug.

Tenant calls send `apikey: <serviceKey>` and additionally
`Authorization: Bearer <serviceKey>` unless the key is a new-style `sb_…` key
(which authenticates via the `apikey` header alone), matching
`apps/cli-go/pkg/fetcher/gateway.go`.

| Method | Path                                           | Auth                           | Request body | Response (used fields)                                             |
| ------ | ---------------------------------------------- | ------------------------------ | ------------ | ------------------------------------------------------------------ |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token                   | none         | `{ref, name, region, status, organization_slug, database.version}` |
| `GET`  | `/v1/projects/{ref}/api-keys?reveal=true`      | Bearer token                   | none         | `[{name, type, api_key, secret_jwt_template}]`                     |
| `GET`  | `https://{ref}.supabase.co/auth/v1/health`     | apikey (+ Bearer if non-`sb_`) | none         | `{version}`                                                        |
| `GET`  | `https://{ref}.supabase.co/rest/v1/`           | apikey (+ Bearer if non-`sb_`) | none         | `{info.version}`                                                   |
| `GET`  | `https://{ref}.supabase.co/storage/v1/version` | apikey (+ Bearer if non-`sb_`) | none         | plain text version body                                            |

## Environment Variables

| Variable                | Purpose                                             | Required?                                                   |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token for Management API linked-version checks | no (falls back to keyring, then `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path             | no (falls back to `~/.supabase/profile` -> `supabase`)      |

## Exit Codes

| Code | Condition                                                                      |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | success; always prints the local service matrix and optionally linked versions |
| `1`  | `--output env` is requested; Go explicitly treats it as unsupported            |

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

- Local versions come from the command's baked-in service matrix; the command does not inspect Docker state or local config files.
- Linked-version checks are best-effort. Remote lookup failures do not change the exit code; they only leave the `LINKED` column empty for unavailable services.
- A malformed linked ref is the one lookup failure that prints an explicit stderr warning (see API Routes above); every other remote failure (network error, expired token, etc.) still fails silently and just leaves `LINKED` empty. Most real-world malformed refs come from an untrimmed `SUPABASE_PROJECT_ID` env var (e.g. a trailing newline from a secrets manager or `.env` file) rather than actual file tampering — the env var is read raw and unlike the on-disk `project-ref` file is never trimmed, matching Go's own `viper.GetString("PROJECT_ID")` (`internal/utils/flags/project_ref.go:62`).
- Version mismatches are reported to stderr as a warning.
- `telemetry.json` is written on every invocation, including `--output env` failures, to match the legacy Go command lifecycle.
