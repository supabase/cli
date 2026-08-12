# `supabase network-restrictions update`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                                                                                            |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` — success and HTTP failure                                                                                  |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via outermost `Effect.ensuring` — including CIDR validation failures. Not written if closed or if flag parsing fails (malformed `--db-allow-cidr` CSV). |

## API Routes

| Method  | Path                                            | Auth         | Request body                                                        | Response (used fields)                                                                                 |
| ------- | ----------------------------------------------- | ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST`  | `/v1/projects/{ref}/network-restrictions/apply` | Bearer token | `{ dbAllowedCidrs: string[], dbAllowedCidrsV6: string[] }`          | `{ config: { dbAllowedCidrs?, dbAllowedCidrsV6? }, status }` (`V1UpdateNetworkRestrictionsOutput`)     |
| `PATCH` | `/v1/projects/{ref}/network-restrictions`       | Bearer token | `{ add: { dbAllowedCidrs: string[], dbAllowedCidrsV6: string[] } }` | `{ config: { dbAllowedCidrs?: Array<{address, type}> }, status }` (`V1PatchNetworkRestrictionsOutput`) |

`POST /apply` is the default (replace mode). `PATCH` is used when `--append=true`.

Both endpoints always receive the full `dbAllowedCidrs` / `dbAllowedCidrsV6` arrays (empty
when no `--db-allow-cidr` was supplied).

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)        |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` → prompt)       |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — network restrictions updated and status printed to stdout                                                                                                                                                                                                                                                                                                                                                                                                   |
| `1`  | malformed CSV in a `--db-allow-cidr` value, e.g. unterminated quote — stderr reproduces the fixed diagnostic text (`invalid argument "\"1.2.3.0/24" for "--db-allow-cidr" flag: parse error on line 1, column 12: extraneous or missing " in quoted-field`; columns are 1-based byte offsets) — fails during flag parsing, before the `--experimental` gate, CIDR validation, the `linked-project.json`/`telemetry.json` writes, and the `cli_command_executed` event |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before CIDR validation/ref/API                                                                                                                                                                                                                                                                                                                            |
| `1`  | CIDR parse failure — `LegacyNetworkRestrictionsInvalidCidrError` (`failed to parse IP: <input>`)                                                                                                                                                                                                                                                                                                                                                                      |
| `1`  | private-IP rejection — `LegacyNetworkRestrictionsPrivateIpError` (`private IP provided: <input>`)                                                                                                                                                                                                                                                                                                                                                                     |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                                                                                                                                                                                                                                                                                                                                               |
| `1`  | API non-201 (POST) / non-200 (PATCH) — `LegacyNetworkRestrictionsUpdateUnexpectedStatusError`                                                                                                                                                                                                                                                                                                                                                                         |
| `1`  | transport failure — `LegacyNetworkRestrictionsUpdateNetworkError`                                                                                                                                                                                                                                                                                                                                                                                                     |

## Telemetry Events Fired

| Event                  | When                                                                                                                                                        | Notable properties / groups                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper); not fired when the `--experimental` gate is closed or when flag parsing fails (malformed `--db-allow-cidr` CSV) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

## CIDR Validation (runs locally before any HTTP call)

For each `--db-allow-cidr` value, in input order:

1. Parse as CIDR. Failure → `failed to parse IP: <input>` and exit `1`.
2. If the parsed IP is private (RFC 1918 for IPv4 — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`;
   RFC 4193 for IPv6 — `fc00::/7`) and `--bypass-cidr-checks=false`, fail with
   `private IP provided: <input>` and exit `1`.
3. Classify as IPv4 / IPv6 and append to the appropriate list (preserving input order).

CIDR validation runs **before** project-ref resolution, so a bad CIDR short-circuits without
touching `linked-project.json`; telemetry still flushes via the outermost `Effect.ensuring`.

## Output

### `--output-format text` (default)

Same three-line template as `get`. In replace mode (POST `/apply`), the arrays come
straight from `response.config.dbAllowedCidrs` / `dbAllowedCidrsV6` (can render
as `<nil>` if the API omits a field). In append mode (PATCH), the V2 response shape is
partitioned by `type` before being printed (always renders as `&[]` or `&[...]`, never `<nil>`).

```
DB Allowed IPv4 CIDRs: &[1.2.3.0/24]
DB Allowed IPv6 CIDRs: &[2001:db8::/64]
Restrictions applied successfully: true
```

`applied successfully` is `true` iff `status === "applied"` in the response.

### `--output {json,yaml,toml,env}`

This command's own text-mode output ignores `-o` entirely — both the POST and PATCH
branches always print the same three-line template shown above. There is no real
struct output for these formats to mirror, so they use the generic map-shaped
`encodeYaml`/`encodeToml` helpers (not the CLI-1975 struct-spec ones): JSON is
alphabetical with trailing newline; env follows the standard flattening rules.

### `--output pretty`

`pretty` is the default `--output` value; it renders identically to
`--output-format text` above — the only output this command ever produces.

### `--output-format json`

The full `V1UpdateNetworkRestrictionsOutput` (or `V1PatchNetworkRestrictionsOutput` in
append mode) emitted as the `success` event payload.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The `--output` flag wins over `--output-format` when both are provided
  (see `--output` above).
- `--append=true` switches the HTTP method (`POST /apply` → `PATCH`) and the request
  envelope (`{ dbAllowedCidrs, dbAllowedCidrsV6 }` → `{ add: { dbAllowedCidrs, dbAllowedCidrsV6 } }`).
- `linked-project.json` writes after a successful project-ref resolution, regardless of
  whether the subsequent API call succeeds.
- `telemetry.json` writes on every invocation past the `--experimental` gate, including
  CIDR validation failures, ref resolution failures, and API failures. A closed gate
  writes nothing. A malformed `--db-allow-cidr` CSV value (e.g. an unterminated quote) also
  writes nothing and fires no telemetry, even with `--experimental` set — it fails during
  flag parsing, before the gate and the handler.
