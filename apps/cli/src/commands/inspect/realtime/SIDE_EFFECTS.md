# `supabase inspect realtime` — side effects

Covers `check`, `listen`, `broadcast` and `presence`. All four share one
connection-resolution path, so their reads and network calls are identical
apart from what they do once joined.

## Files read

| Path                                               | Format | When                                                                                                                                  |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                   | TOML   | Local target only: resolving the API URL and the publishable/anon key. Skipped entirely when `--url` **and** a key are both supplied. |
| `<workdir>/supabase/.env`, `.env.local`            | dotenv | Loaded with the config, for `SUPABASE_*` overrides. `.env.local` is skipped when `SUPABASE_ENV=test`.                                 |
| `<workdir>/supabase/.temp/project-ref`             | text   | Linked target only, via `ProjectRefResolver`.                                                                                         |
| `~/.supabase/access-token` (or the native keyring) | text   | Linked target only, to call the Management API.                                                                                       |

## Files written

| Path                                           | Format | When                                                                                          |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | Only when a project ref was resolved (the linked path). Written on success and failure alike. |
| `~/.supabase/telemetry.json`                   | JSON   | Every invocation, on success and failure alike.                                               |

No credential obtained by these commands is persisted: a user token from
`--user-token` or `--email`/`--password` lives only for the duration of the
process.

## API routes called

| Method | Path                                      | When                                                                                                                                                                  |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{ref}/api-keys`             | Linked target only. `reveal=true` is added only for `--service-role`/`--secret-key`-by-project, which needs the secret key.                                           |
| `GET`  | `<url>/realtime/v1/websocket?apikey=…`    | Every invocation of `check`; also the auto-detect probe when neither `--local` nor `--linked` was given. Plain HTTP, no upgrade — used only to classify the endpoint. |
| `POST` | `<url>/auth/v1/token?grant_type=password` | `--email` only. Body `{email, password}`; the response's `access_token` is used as the user JWT.                                                                      |
| `WSS`  | `<url>/realtime/v1/websocket`             | Every command except a `check` that fails at the probe.                                                                                                               |

The `apikey` query param on the websocket route is the only place both a local
Kong gateway and a hosted deployment read the key, so it travels there rather
than in a header. `redactHttpUrl` redacts it from `--debug` output.

## Environment variables consumed

| Variable                                                        | Effect                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `SUPABASE_URL`                                                  | Default for `--url`.                                        |
| `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY`                 | Default for `--api-key`, in that order.                     |
| `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`              | Consulted for `--service-role`, in that order.              |
| `SUPABASE_AUTH_*`, `SUPABASE_API_*`                             | Fold into the local config resolution, as for `status`.     |
| `SUPABASE_ENV`                                                  | `test` excludes `supabase/.env.local` from the dotenv walk. |
| `SUPABASE_PROFILE`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_WORKDIR` | As for every command.                                       |

## Exit codes

| Code | Condition                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | The command did what was asked. For `listen` this includes a tail that received nothing: an empty log is a finding, not a failure.                                                                                                                                                         |
| `1`  | `check`: any step failed (endpoint unreachable, key rejected, no server, gateway 502/503/504, channel rejected, database subscription refused). Others: the channel never joined, a broadcast was not acknowledged, sign-in failed, a flag value was invalid, or `-o/--output` was passed. |

## Notes

- `-o/--output` is refused outright; machine output is `--output-format json|stream-json`
  only (the `config diff` precedent, CLI-2156).
- In `json` and `stream-json` modes stdout carries only the payload; progress,
  warnings and errors go to stderr. `listen` emits one `realtime-frame` event
  per frame rather than one terminal `result`, since a tail has no natural end.
- `--service-role`/`--secret-key` bypass RLS, so a channel that joins with one
  says nothing about whether an application user could join it. The text output
  states this on the connection line.
