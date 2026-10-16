# `supabase vanity-subdomains delete`

## Files Read

| Path                                           | Format                    | When                                                                                                                 |
| ---------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                           |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write            |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--project-ref` flag and `SUPABASE_PROJECT_ID` env are both unset; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if gate is closed.                                                                                                                                                 |

## API Routes

| Method   | Path                                  | Auth         | Request body | Response (used fields)                                                                                                                                                                                       |
| -------- | ------------------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`                        | Bearer token | none         | project list for the interactive picker — only when no ref comes from `--project-ref`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                               |
| `DELETE` | `/v1/projects/{ref}/vanity-subdomain` | Bearer token | none         | none                                                                                                                                                                                                         |
| `GET`    | `/v1/projects/{ref}`                  | Bearer token | none         | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available |

## Environment Variables

| Variable                | Purpose                                                                                                     | Required?                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                        | no (falls back to keyring then `~/.supabase/access-token`)                                    |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                     | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                          | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag                                                    | no (pass `--experimental` instead; one of the two is required)                                |
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored) | no                                                                                            |

## Exit Codes

| Code | Condition                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                   |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) — checked before ref resolution/API/telemetry |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError` / `InvalidProjectRefError`)                                                            |
| `1`  | API non-2xx (`VanitySubdomainsDeleteUnexpectedStatusError`)                                                                               |
| `1`  | transport failure (`VanitySubdomainsDeleteNetworkError`)                                                                                  |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed                    |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                                      |

## Telemetry Events Fired

| Event                  | When                                                                                           | Notable properties / groups         |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper); not fired when the `--experimental` gate is closed | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text` / legacy `--output pretty`

Prints to stderr:

```text
Deleted vanity subdomain successfully.
```

### `--output {json,yaml,toml,env}`

Ignored. The same stderr success line is printed.

### `--output-format json`

Single structured success event when the `--output` flag is unset.

### `--output-format stream-json`

One `result` event when the `--output` flag is unset.

## Notes

- The `--output` flag wins over TS `--output-format` when both are provided.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is
  open), even when the API call fails, but only on a cache miss with a token when
  `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed
  gate writes nothing.

- Prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after the project is resolved and before the POST, with default No: `Delete the vanity subdomain`. The question notes that routing reverts to the project ref hostname. `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.
