# `supabase config pull`

Pulls the effective hosted configuration for a preview branch and compares it
with the local project configuration. The command does not modify local or
remote configuration.

## Files read

| Path                                           | Format     | When                                                        |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `<workdir>/supabase/config.toml` or `.json`    | TOML/JSON  | Before the Management API request                           |
| `<workdir>/supabase/.env` and `.env.local`     | dotenv     | While resolving `env(...)` references in project config     |
| `<workdir>/supabase/.temp/project-ref`         | plain text | When no project reference is set through flags or the shell |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | When resolving linked-project telemetry state               |
| `~/.supabase/access-token`                     | plain text | When `SUPABASE_ACCESS_TOKEN` and keyring access are absent  |

## Files written

| Path                                           | Format | When                                                    |
| ---------------------------------------------- | ------ | ------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | After the project reference resolves, including failure |
| `~/.supabase/telemetry.json`                   | JSON   | After the command runs, including failure               |

The command never writes `supabase/config.toml` or `supabase/config.json`.

## API routes

The request uses bearer authentication.

| Method | Path                        | Query             | Success |
| ------ | --------------------------- | ----------------- | ------- |
| `GET`  | `/v1/projects/{ref}/config` | `branch={target}` | `200`   |

The response contains `auth` and `api` objects shaped like the Supabase config
schema. The endpoint omits credential values. A `404` response means the exact
target branch does not exist.

## Environment variables

| Variable                | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `SUPABASE_PROJECT_ID`   | Resolves the parent project reference              |
| `SUPABASE_ACCESS_TOKEN` | Authenticates the Management API request           |
| `SUPABASE_PROFILE`      | Selects the Management API profile                 |
| `env(VAR)` references   | Resolves values while loading local project config |

## Exit codes

| Code | Condition                                             |
| ---- | ----------------------------------------------------- |
| `0`  | The comparison completes, with or without differences |
| `1`  | The target is empty or does not exist                 |
| `1`  | Local project config is missing or invalid            |
| `1`  | The API request fails or returns an invalid response  |

## Output

Text output lists each changed config path with its local and remote values.
`--output-format json` and `stream-json` emit a structured result containing
`project_ref`, `target`, and `changes`. The legacy `--output` formats remain
available for compatibility.
