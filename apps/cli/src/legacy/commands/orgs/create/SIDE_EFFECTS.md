# `supabase orgs create`

## Files Read

| Path                                      | Format                    | When                                                                                          |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile` |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                      |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                 |

## Files Written

| Path                         | Format | When                                                        |
| ---------------------------- | ------ | ----------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always (in `Effect.ensuring`) at end of command — Go parity |

`orgs create` is a user-level command — it does not resolve a `--project-ref`, so the legacy
linked-project cache is never written.

## Positional Arguments

| Argument | Required? | Description                  |
| -------- | --------- | ---------------------------- |
| `name`   | yes       | Name of the new organization |

## API Routes

| Method | Path                | Auth         | Request body     | Response (used fields)                     |
| ------ | ------------------- | ------------ | ---------------- | ------------------------------------------ |
| `POST` | `/v1/organizations` | Bearer token | `{name: string}` | `{id: string, slug: string, name: string}` |

## Environment Variables

| Variable                | Purpose                                                                                                                                                   | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                      | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | selects API base URL (`supabase`, `supabase-staging`, `supabase-local`), or a filesystem path to a YAML profile (Go parity — used by the cli-e2e harness) | no (defaults to `supabase`)                             |

## Exit Codes

| Code | Condition                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | success — organization created                                                  |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                |
| `1`  | `LegacyOrgsCreateUnexpectedStatusError` — non-201 response from create endpoint |
| `1`  | `LegacyOrgsCreateNetworkError` — transport-level network failure                |

Unlike `orgs list`, there is no env-not-supported branch — Go's `EncodeOutput` happily
flattens a single object into `ID=… NAME=… SLUG=…` env lines.

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

Matches `apps/cli-go/internal/orgs/create/`. Go does not fire any custom telemetry event for
this command.

## Output

Every output mode (Go-compat and TS) starts by printing `Created organization: <id>\n` to
stdout, except `--output-format json` / `stream-json`, which emit a single structured event
instead. `--output` (Go) wins over `--output-format` (TS) when both are supplied.

### `--output pretty` (Go default) / `--output-format text`

`Created organization: <id>` followed by a Glamour-styled markdown table with columns
`ID`, `NAME` for the created organization. The rendered table always ends with a trailing
newline (Glamour appends one).

### `--output json` (Go-compat)

Preamble line followed by indented JSON of the created `OrganizationResponseV1` object with
alphabetical keys + trailing newline.

### `--output yaml`

Preamble line followed by a YAML document of the created organization object.

### `--output toml`

Preamble line followed by a TOML document of the created organization object.

### `--output env`

Preamble line followed by `ID=…`, `NAME=…`, `SLUG=…` env lines — env IS supported here,
unlike on `orgs list`. Matches the Go encoder behavior in
`apps/cli-go/internal/orgs/create/create.go:27`.

### `--output-format json`

Single `Output.success` envelope written as JSON. The envelope carries the message
`"Created organization"` plus the created org spread into `data` (`{id, slug, name}`). No
`Created organization: <id>\n` preamble line — the message is delivered as a structured
field instead of stdout text.

### `--output-format stream-json`

One `result` NDJSON event with the created org as `data` and the same `"Created organization"`
message. No preamble line.

## Notes

- Takes exactly one positional argument: the organization name.
- No `--project-ref` flag. `orgs create` is a user-level command.
- The organization `id` and `slug` in the response are human-readable slugs (e.g.
  `combined-fuchsia-lion`), not UUIDs.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth.

## Security Notes

- The `Created organization: <id>` preamble and the rendered Glamour table interpolate the
  API-supplied `id` and `name` strings without ANSI / control-character sanitization. This
  is strict Go parity — Go's `fmt.Println` and `glamour` both pass these through verbatim.
  A malicious or compromised Management API could in principle return values containing
  terminal escape sequences. If sanitization is added later it should land at the renderer
  (and at any shared preamble helper) so both shells inherit the fix.
- `--output env` values are escaped via `encodeEnv` (`\n`, `\r`, `\t` → backslash-escaped),
  matching Go's `%q` semantics. ESC (`0x1b`) is not escaped — again Go parity.
- Error response bodies embedded in `LegacyOrgsCreateUnexpectedStatusError` are sanitized
  by `mapLegacyHttpError` (control chars stripped, capped at 1024 bytes).
