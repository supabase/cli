# `supabase vanity-subdomains activate`

## Files Read

| Path                                           | Format                    | When                                                                                                                                                               |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                                         |
| `<workdir>/supabase/.temp/linked-project.json` | JSON                      | always, after the project ref resolves — `linkedProjectCache` checks it exists to decide whether to write                                                          |
| `<workdir>/supabase/.temp/project-ref`         | plain text (project ref)  | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` env are both unset, and as the linked parent for `--remote=<branch>`; also by `linkedProjectCache` on a cache miss |

## Files Written

| Path                                           | Format | When                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/.temp/linked-project.json` | JSON   | once the `--experimental` gate is open, in `Effect.ensuring` after the project ref resolves, on success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and `GET /v1/projects/{ref}` succeeds |
| `~/.supabase/telemetry.json`                   | JSON   | once the `--experimental` gate is open, via `Effect.ensuring` — on success and failure. Not written if gate is closed.                                                                                                                                                 |

## API Routes

| Method | Path                                           | Auth         | Request body                   | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------- | ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects`                                 | Bearer token | none                           | project list for the interactive picker — only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref` and stdin is a TTY with interactive output                                                                          |
| `GET`  | `/v1/projects/{parent}/branches`               | Bearer token | none                           | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`                            | Bearer token | none                           | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| `POST` | `/v1/projects/{ref}/vanity-subdomain/activate` | Bearer token | `{ vanity_subdomain: string }` | `{ custom_domain: string }`                                                                                                                                                                                                                              |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none                           | `{organization_slug}` — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                                                                                              |
| `GET`  | `/v1/organizations/{slug}/entitlements`        | Bearer token | none                           | `{entitlements[].feature.key, .hasAccess}` (key `vanity_subdomain`) — upgrade-gate side-call on a 4xx with no plan-gate error in the body                                                                                                                |
| `GET`  | `/v1/projects/{ref}`                           | Bearer token | none                           | `{ref, name, organization_id, organization_slug}` — `linkedProjectCache` fill, best-effort, skipped when `.temp/linked-project.json` exists, `.temp/project-ref` names another ref, or no token is available                                             |

## Environment Variables

| Variable                | Purpose                                                                                                                   | Required?                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                      | no (falls back to keyring then `~/.supabase/access-token`)                                    |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                                   | no (falls back to `~/.supabase/profile` -> `supabase`)                                        |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the interactive project picker on a TTY) |
| `SUPABASE_EXPERIMENTAL` | enables `--experimental`-gated commands without the flag                                                                  | no (pass `--experimental` instead; one of the two is required)                                |
| `SUPABASE_YES`          | approves the hosted-mutation confirmation like `--yes` (shell environment only; `supabase/.env` is ignored)               | no                                                                                            |

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                |
| `1`  | `--experimental` not passed and `SUPABASE_EXPERIMENTAL` unset (`ExperimentalRequiredError`) — checked before ref resolution/API/telemetry                                                                              |
| `1`  | project ref unresolved (`ProjectRefNotLinkedError`; `InvalidProjectRefError` for a malformed `SUPABASE_PROJECT_ID` or link-file ref)                                                                                   |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |
| `1`  | `--desired-subdomain` omitted (`DesiredSubdomainRequiredError`) — checked after gate/login/ref resolution; telemetry still fires                                                                                       |
| `1`  | API non-2xx (`VanitySubdomainsActivateUnexpectedStatusError`)                                                                                                                                                          |
| `1`  | transport failure (`VanitySubdomainsActivateNetworkError`)                                                                                                                                                             |
| `1`  | `HostedMutationConsentRequiredError` — no `--yes` / shell `SUPABASE_YES` and the run cannot prompt; nothing is changed                                                                                                 |
| `1`  | `HostedMutationDeclinedError` — the confirmation prompt was declined                                                                                                                                                   |

## Telemetry Events Fired

| Event                   | When                                                                                           | Notable properties / groups                |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `cli_command_executed`  | post-run, success or failure (via wrapper); not fired when the `--experimental` gate is closed | `exit_code`, `duration_ms`, `flags`        |
| `cli_upgrade_suggested` | gated 4xx responses only                                                                       | `feature_key=vanity_subdomain`, `org_slug` |

## Output

### `--output-format text` / legacy `--output pretty`

Prints:

```text
Activated vanity subdomain at <custom_domain>
```

### `--output {json,yaml,toml,env}`

Encodes the response object directly.

### `--output-format json`

Single structured success event with the full response object.

### `--output-format stream-json`

One `result` event with the full response object.

## Notes

- The `--output` flag wins over TS `--output-format` when both are provided.
- `.temp/linked-project.json` is written after ref resolution (once the `--experimental` gate is
  open), even when the API call fails, but only on a cache miss with a token when
  `GET /v1/projects/{ref}` succeeds and `.temp/project-ref` does not name another ref. A closed
  gate writes nothing.
- On gated 4xx responses this command prints an upgrade suggestion and fires `cli_upgrade_suggested`.
- `--desired-subdomain` is required, but only enforced in the handler (after gate → login → ref
  resolution) rather than at parse time, using the fixed wording
  `required flag(s) "desired-subdomain" not set`. The gate/login/ref errors win over the missing
  flag, and telemetry still fires and the cache fill still runs on this failure. An explicit
  empty value (`--desired-subdomain ""`) passes the check and reaches the API — only presence is
  required, not a non-empty value.

- Prints `Target: <project>` once on stderr in every output format, for example `Target: project <name> (<ref>) · production`. `--output-format json|stream-json` object results and error envelopes also carry a `target` object; `--output {json,yaml,toml,env}` payloads are unchanged.
- **Consent.** Asks once, after `--desired-subdomain` is checked and before the POST, with default No: `Activate vanity subdomain <name>`. The question notes that auth services stop working on the project's default hostname. `--yes` or a shell `SUPABASE_YES` approves it (`supabase/.env` does not) and echoes `Confirmed by --yes: <action> on <target>` to stderr. Without it, only an interactive text-mode terminal is asked: JSON, `-o`, piped and agent runs exit 1 with `HostedMutationConsentRequiredError` and change nothing, and declining exits 1 with `HostedMutationDeclinedError`. Stdin is never read.
- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase vanity-subdomains activate` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A word after a bare `--remote` is read as its value, `--remote=<word>`, because the command takes
  no operands.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
