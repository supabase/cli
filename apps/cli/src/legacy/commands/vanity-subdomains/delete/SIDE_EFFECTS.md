# `supabase vanity-subdomains delete`

## Files Read

| Path                                   | Format                    | When                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable             |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                                                                                   |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | once the `--experimental` gate is open, after ref resolution, via `Effect.ensuring` — on success and failure           |
| `~/.supabase/telemetry.json`                     | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if gate is closed. |

## API Routes

| Method   | Path                                  | Auth         | Request body | Response (used fields) |
| -------- | ------------------------------------- | ------------ | ------------ | ---------------------- |
| `DELETE` | `/v1/projects/{ref}/vanity-subdomain` | Bearer token | none         | none                   |

## Environment Variables

| Variable                | Purpose                                                  | Required?                                                      |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)     | no (falls back to keyring then `~/.supabase/access-token`)     |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                  | no (falls back to `~/.supabase/profile` -> `supabase`)         |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset       | no (falls back to `supabase/.temp/project-ref`)                |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag | no (pass `--experimental` instead; one of the two is required) |

## Exit Codes

| Code | Condition                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                         |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`LegacyExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`)                                                         |
| `1`  | API non-2xx (`LegacyVanitySubdomainsDeleteUnexpectedStatusError`)                                                                               |
| `1`  | transport failure (`LegacyVanitySubdomainsDeleteNetworkError`)                                                                                  |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` / legacy `--output pretty`

Prints to stderr:

```text
Deleted vanity subdomain successfully.
```

### Legacy `--output {json,yaml,toml,env}`

Ignored, matching the old Go command. The same stderr success line is printed.

### `--output-format json`

Single structured success event when the legacy `--output` flag is unset.

### `--output-format stream-json`

One `result` event when the legacy `--output` flag is unset.

## Notes

- The legacy `--output` flag wins over TS `--output-format` when both are provided.
- `linked-project.json` is written after ref resolution, even when the API call fails.
