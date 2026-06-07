# `supabase network-restrictions get`

## Files Read

| Path                                   | Format                    | When                                                          |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                          |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (after ref resolution), via `Effect.ensuring` — on success and failure |
| `~/.supabase/telemetry.json`                     | JSON   | always, via `Effect.ensuring` — on success and failure                        |

## API Routes

| Method | Path                                      | Auth         | Request body | Response (used fields)                                                                                                                                           |
| ------ | ----------------------------------------- | ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/network-restrictions` | Bearer token | none         | `{ config: { dbAllowedCidrs?: string[], dbAllowedCidrsV6?: string[] }, status: "stored" \| "applied" }` (see `V1GetNetworkRestrictionsOutput` in `packages/api`) |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)  |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)              |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref` → prompt) |

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success — network-restrictions status printed to stdout                                 |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`) |
| `1`  | API non-200 (`LegacyNetworkRestrictionsGetUnexpectedStatusError`)                       |
| `1`  | transport failure (`LegacyNetworkRestrictionsGetNetworkError`)                          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                          |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

Matches `apps/cli-go/internal/restrictions/get/`. Go does not fire any custom telemetry event for this command.

## Output

### `--output-format text` (default) — Go CLI compatible

Three hardcoded lines using Go's `fmt.Printf` slice rendering. The IPv4 and IPv6 fields
are emitted byte-for-byte from Go's `%+v` on `*[]string`:

- field absent in the API response → `<nil>`
- field present, empty array → `&[]`
- field present, populated → `&[a b c]` (single-space separated, no quotes)

```
DB Allowed IPv4 CIDRs: &[1.2.3.0/24 5.6.7.0/24]
DB Allowed IPv6 CIDRs: &[2001:db8::/64]
Restrictions applied successfully: true
```

`applied successfully` is `true` iff `status === "applied"` in the response.

### Go `--output {json,yaml,toml,env}`

Byte-identical to the Go CLI's encoders (`apps/cli-go/internal/utils/output.go`).

- `json` — alphabetical struct-field order with trailing newline.
- `yaml` — `stringifyYaml(response)`.
- `toml` — `stringifyToml(response)` with trailing newline.
- `env` — Viper-flattened SCREAMING_SNAKE_CASE keys.

### Go `--output pretty`

Same as `text` mode (Go's default).

### `--output-format json`

The full `V1GetNetworkRestrictionsOutput` emitted as the `success` event payload.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided.
- `linked-project.json` is written **after** the project ref is resolved, regardless of
  whether the subsequent API call succeeds (mirrors Go's `PersistentPostRun`).
- `telemetry.json` is written on every invocation, including failures.
- Go's `restrictions/get` itself does not honor `--output`. The legacy TS port honors both
  `--output` and `--output-format` per the legacy CLAUDE.md output-parity rules.
