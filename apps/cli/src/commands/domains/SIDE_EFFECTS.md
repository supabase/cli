# `supabase domains [create|get|reverify|activate|delete]`

Target: hosted, consent default Yes for `create`, No for `activate` and `delete`, no consent for `get` and `reverify` — see [Command target](../../../docs/command-target.md)

Custom hostname management. Every subcommand resolves a project ref and calls a
single Management API custom-hostname endpoint. `create` additionally performs a
Cloudflare DNS-over-HTTPS CNAME pre-check.

## Files Read

| Path                                           | Format                    | When                                                                            |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                      |
| `<workdir>/supabase/.temp/project-ref`         | plain text                | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set                  |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | existence check only — `linkedProjectCache` skips its fill when the file exists |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | always (post-run), success or failure                                                                                                                                                                                          |

## API Routes

| Method   | Path                                            | Auth         | Request body                | Response (used fields)                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------- | ------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/projects`                                  | Bearer token | none                        | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`    | `https://1.1.1.1/dns-query?name=<host>&type=5`  | none         | none                        | `{Answer: [{type, data}]}` — first CNAME answer (`create` only, before the POST)                                                                                                                                                                         |
| `POST`   | `/v1/projects/{ref}/custom-hostname/initialize` | Bearer token | `{custom_hostname: string}` | 201 → `{status, custom_hostname, data: {result: {ssl, custom_origin_server, …}}}` (`create`)                                                                                                                                                             |
| `GET`    | `/v1/projects/{ref}/custom-hostname`            | Bearer token | none                        | 200 → same response shape (`get`)                                                                                                                                                                                                                        |
| `POST`   | `/v1/projects/{ref}/custom-hostname/reverify`   | Bearer token | none                        | 201 → same response shape (`reverify`)                                                                                                                                                                                                                   |
| `POST`   | `/v1/projects/{ref}/custom-hostname/activate`   | Bearer token | none                        | 201 → same response shape (`activate`)                                                                                                                                                                                                                   |
| `DELETE` | `/v1/projects/{ref}/custom-hostname`            | Bearer token | none                        | 200 → empty/void body (`delete`)                                                                                                                                                                                                                         |
| `GET`    | `/v1/projects/{ref}`                            | Bearer token | none                        | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |
| `GET`    | `/v1/projects/{parent}/branches`                | Bearer token | none                        | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`    | `/v1/branches/{id}`                             | Bearer token | none                        | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |

## Environment Variables

| Variable                | Purpose                                                                                                     | Required?                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                        | no (falls back to keyring → `~/.supabase/access-token`)                   |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is not given                                                     | no (falls back to `supabase/.temp/project-ref`, then the picker on a TTY) |
| `SUPABASE_PROFILE`      | built-in profile name or path to a YAML profile                                                             | no (defaults to `supabase`; sets API URL + project host)                  |
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored) | no                                                                        |

## Exit Codes

| Code | Condition                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                |
| `1`  | project ref cannot be resolved / is malformed                                                                          |
| `1`  | `create`: hostname has no matching CNAME record (Cloudflare DNS pre-check)                                             |
| `1`  | API error — unexpected (non-201/200) response from the custom-hostname endpoint                                        |
| `1`  | network / connection failure                                                                                           |
| `1`  | `--include-raw-output` passed at all (any value, including `=false`) — removed, see Notes                              |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                   |

## Telemetry Events Fired

| Event                   | When                                                                                  | Notable properties / groups                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cli_command_executed`  | post-run, success or failure (via wrapper)                                            | `exit_code`, `duration_ms`, `flags` (all redacted — no `domains` flag is telemetry-safe); a rejected `--include-raw-output` fails with `error_fingerprint` ending in `:removed_flag` (`RemovedSurfaceError`) |
| `cli_upgrade_suggested` | `create`/`get`/`activate`/`reverify` 4xx carrying the `entitlement_required` envelope | `feature_key` (from the envelope), `org_slug` (parsed from `upgrade_url`); envelope-only, no entitlements fallback                                                                                           |

## Output

In `pretty`/text mode the `PrintStatus` text is written to **stderr** and nothing
to stdout. In a structured `-o` mode (`json`/`yaml`/`toml`/`env`) the encoded
response goes to **stdout** and the human status is suppressed on stderr (see the
notes below). `delete` only prints a fixed success line to stderr and
ignores `-o`.

### `--output-format text`

stderr carries the status message for the hostname's current state, e.g.:

```
Custom hostname configuration not started.
```

`delete` prints `Deleted custom hostname config successfully.` to stderr. stdout is empty in text mode.

### `--output-format json`

Single JSON object (the full custom-hostname response) emitted via `output.success`.
`delete` emits `{}` with the success message.

### `--output-format stream-json`

A `result` event carrying the custom-hostname response object.

### `-o {json,yaml,toml,env}`

When the `--output`/`-o` flag is set,
the full response is encoded to stdout in that format and the human status is
suppressed on stderr. `delete` ignores `-o`.

## Notes

- `--custom-hostname` is required for `create`.
- `create` validates the CNAME via Cloudflare DNS-over-HTTPS (`https://1.1.1.1`, 10s timeout) before initializing; on failure it short-circuits before any POST.
- **Notes:**
  - `--include-raw-output` is removed on every subcommand, `delete` included. Passing it (any value, including `=false`) fails with `--include-raw-output was removed.` and the suggestion `Use -o json instead.`, before credentials are resolved or any API work runs, so it needs no login. `RemovedSurfaceError` records `cli_command_executed` with `error_fingerprint` ending in `:removed_flag`, and the post-run `telemetry.json` read and write under `SUPABASE_HOME` still happens. The flag stays parsed (hidden) only so misuse reaches this error instead of an unknown-flag parse error; its rejection lives in `domains.removed-flag.ts`.
  - The degenerate `validation_records != 1` status message is an approximate struct dump (the exact text is not stable).
  - Text-mode status output is newline-terminated. Without the final newline, interactive shell prompts can redraw over the last status line, hiding the ACME TXT record.
  - In a structured `-o` mode the human status is suppressed on stderr, keeping stdout clean.
  - The CNAME pre-check's "failed to locate" error text embeds a readable, 1024-byte-capped JSON dump of the DNS answers, rather than an uncapped decimal byte-value array — see `domains.cname.ts`'s comment at the failure site for detail.

- **Consent (`create`).** Asks once, after the CNAME pre-check passes and before the POST, with default Yes: `Create custom hostname <hostname>`.
- **Consent (`activate`).** Asks once before the POST, with default No: `Activate the custom hostname`. The question notes that third-party auth providers stop working on the Supabase-provisioned subdomain.
- **Consent (`delete`).** Asks once before the DELETE, with default No: `Delete the custom hostname config`.
- `get` never prompts. `reverify` never prompts: it re-runs verification and changes no configuration.
