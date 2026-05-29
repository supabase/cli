# `supabase vanity-subdomains activate`

## Files Read

| Path                                   | Format                    | When                                                          |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable    |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)  | when `--project-ref` flag and `PROJECT_ID` env are both unset |

## Files Written

| Path                                             | Format | When                                                  |
| ------------------------------------------------ | ------ | ----------------------------------------------------- |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | after ref resolution, on success and failure          |
| `~/.supabase/telemetry.json`                     | JSON   | always, via `Effect.ensuring`, on success and failure |

## API Routes

| Method | Path                                  | Auth         | Request body                   | Response (used fields)      |
| ------ | ------------------------------------- | ------------ | ------------------------------ | --------------------------- |
| `POST` | `/v1/projects/{ref}/vanity-subdomain` | Bearer token | `{ vanity_subdomain: string }` | `{ custom_domain: string }` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                  |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring then `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)                |
| `PROJECT_ID`            | project ref fallback when `--project-ref` is unset   | no (falls back to `supabase/.temp/project-ref`)            |

## Exit Codes

| Code | Condition                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| `0`  | success                                                                                 |
| `1`  | project ref unresolved (`LegacyProjectNotLinkedError` / `LegacyInvalidProjectRefError`) |
| `1`  | API non-2xx (`LegacyVanitySubdomainsActivateUnexpectedStatusError`)                     |
| `1`  | transport failure (`LegacyVanitySubdomainsActivateNetworkError`)                        |

## Telemetry Events Fired

| Event                   | When                                       | Notable properties / groups                |
| ----------------------- | ------------------------------------------ | ------------------------------------------ |
| `cli_command_executed`  | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`        |
| `cli_upgrade_suggested` | gated 4xx responses only                   | `feature_key=vanity_subdomain`, `org_slug` |

## Output

### `--output-format text` / legacy `--output pretty`

Prints:

```text
Activated vanity subdomain at <custom_domain>
```

### Legacy `--output {json,yaml,toml,env}`

Encodes the response object directly.

### `--output-format json`

Single structured success event with the full response object.

### `--output-format stream-json`

One `result` event with the full response object.

## Notes

- The legacy `--output` flag wins over TS `--output-format` when both are provided.
- `linked-project.json` is written after ref resolution, even when the API call fails.
- On gated 4xx responses this command prints an upgrade suggestion and fires `cli_upgrade_suggested`.
