# `supabase projects create`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                | Auth         | Request body                                                                                     | Response (used fields)                                           |
| ------ | ------------------- | ------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET`  | `/v1/organizations` | Bearer token | —                                                                                                | `[{id, slug, name}]` — interactive org prompt only               |
| `POST` | `/v1/projects`      | Bearer token | `{name, organization_slug, db_pass, region?, desired_instance_size?, high_availability?}` (JSON) | `{id, ref, name, organization_slug, region, created_at, status}` |

## Environment Variables

| Variable                | Purpose                                                                                                               | Required?                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                  | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                                                                                      | no (defaults to `https://api.supabase.com`)             |
| `DB_PASSWORD`           | **not consumed** — Go only mirrors `--db-password` into viper for local-stack reuse; `projects create` never reads it | n/a                                                     |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success — new project created and details displayed |
| `1`  | authentication error — no valid token found         |
| `1`  | API error — non-2xx response from `/v1/projects`    |
| `1`  | network / connection failure                        |
| `1`  | required flags missing in non-interactive mode      |
| `1`  | empty project name (interactive prompt left blank)  |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                                |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--org-id`, `--high-availability` are telemetry-safe) |

## Flags

| Flag                  | Type   | Required (non-interactive) | Description                                     |
| --------------------- | ------ | -------------------------- | ----------------------------------------------- |
| `[project name]`      | arg    | yes (non-interactive)      | Name of the project (positional argument)       |
| `--org-id`            | string | yes (non-interactive)      | Organization ID (slug) to create the project in |
| `--db-password`       | string | yes (non-interactive)      | Database password for the project               |
| `--region`            | enum   | yes (non-interactive)      | AWS region for the project                      |
| `--size`              | enum   | no                         | Desired instance size                           |
| `--high-availability` | bool   | no                         | Enable high availability for the project        |
| `--interactive`       | bool   | no (default: true)         | Enable interactive mode (hidden flag)           |
| `--plan`              | string | no                         | Plan selection (hidden flag)                    |

## Output

### `--output-format text` (Go CLI compatible)

Displays a confirmation message and project details after successful creation.

### `--output-format json`

Single JSON object emitted to stdout on success, containing the created project fields.

```json
{
  "id": "abcdefghijklmnopqrst",
  "organization_slug": "combined-fuchsia-lion",
  "name": "my-project",
  "region": "us-east-1",
  "created_at": "2022-04-25T02:14:55.906498Z"
}
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":{"id":"abcdefghijklmnopqrst","name":"my-project","region":"us-east-1","organization_slug":"combined-fuchsia-lion","created_at":"2022-04-25T02:14:55.906498Z"}}
```

## Notes

- In interactive mode (default when stdin is a TTY), the user is prompted for any missing
  required fields (`--org-id`, `--db-password`, `--region`, project name).
- In non-interactive mode (when stdin is not a TTY or `--interactive=false`), all three
  flags and the positional project name argument are required.
- The `--size` flag, when provided, sets the `desired_instance_size` field in the request body.
- The `--high-availability` flag, when provided, sets the `high_availability` field in the request body.
- The `--plan` flag is hidden and reserved.
