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

The resolved project ref must match `^[a-z]{20}$` (Go's `utils.ProjectRefPattern`)
before any remote lookup runs; a malformed ref skips the linked-version checks
and only the local matrix is printed. Tenant calls send `apikey: <serviceKey>`
and additionally `Authorization: Bearer <serviceKey>` unless the key is a
new-style `sb_…` key (which authenticates via the `apikey` header alone),
matching `apps/cli-go/pkg/fetcher/gateway.go`.

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
| `SUPABASE_API_URL`      | override Management API base URL                    | no (defaults to `https://api.supabase.com`)                 |

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
- Version mismatches are reported to stderr as a warning.
- `telemetry.json` is written on every invocation, including `--output env` failures, to match the legacy Go command lifecycle.
