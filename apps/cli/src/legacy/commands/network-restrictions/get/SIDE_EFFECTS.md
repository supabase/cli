# `supabase network-restrictions get`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                       |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` — on success and failure               |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if the gate is closed. |

## API Routes

| Method | Path                                      | Auth         | Request body | Response (used fields)                                                                                                                                           |
| ------ | ----------------------------------------- | ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/network-restrictions` | Bearer token | none         | `{ config: { dbAllowedCidrs?: string[], dbAllowedCidrsV6?: string[] }, status: "stored" \| "applied" }` (see `V1GetNetworkRestrictionsOutput` in `packages/api`) |

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring → `~/.supabase/access-token`)        |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref` → prompt)       |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — network-restrictions status printed to stdout                                                                                         |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                         |
| `1`  | API non-200 (`LegacyNetworkRestrictionsGetUnexpectedStatusError`)                                                                               |
| `1`  | transport failure (`LegacyNetworkRestrictionsGetNetworkError`)                                                                                  |

## Telemetry Events Fired

| Event                  | When                                                                                           | Notable properties / groups                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper); not fired when the `--experimental` gate is closed | `exit_code`, `duration_ms`, `flags` (`--project-ref` → `<redacted>`) |

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

### `--output {json,yaml,toml,env}` (Go flag, TS-only behavior here)

Go's `restrictions/get` (`apps/cli-go/internal/restrictions/get/get.go:21-23`) never
reads `OutputFormat` — it always prints the three `fmt.Printf` lines above, whatever
`-o` says, so there is no Go output here to be byte-identical to (and therefore no
Go casing convention to match either — TS uses the generic map-shaped
`encodeYaml`/`encodeToml` helpers here, not the CLI-1975 struct-spec ones, since
there is no real Go struct output for this command to mirror):

- `json` — alphabetical struct-field order with trailing newline.
- `yaml` — `stringifyYaml(response)`.
- `toml` — `stringifyToml(response)` with trailing newline.
- `env` — Viper-flattened SCREAMING_SNAKE_CASE keys.

### `--output pretty`

`pretty` is Go's default `--output` value; TS renders it identically to
`--output-format text` above — the only output Go's `restrictions get` ever produces.

### `--output-format json`

The full `V1GetNetworkRestrictionsOutput` emitted as the `success` event payload.

### `--output-format stream-json`

One `result` event whose `data` is the full response object.

## Notes

- The Go `--output` flag wins over the TS `--output-format` flag when both are provided
  (a TS-internal precedence rule between the port's two flags — see `--output` above).
- `linked-project.json` is written **after** the project ref is resolved, regardless of
  whether the subsequent API call succeeds (mirrors Go's `PersistentPostRun`).
- `telemetry.json` is written on every invocation past the `--experimental` gate, including
  failures. A closed gate writes nothing (Go's `PersistentPreRunE` fails before
  `PersistentPostRun` runs).
