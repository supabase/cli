# `supabase feedback add [message...]`

## Files Read

| Path                                   | Format                              | When                                                                                                                                              |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/profile`                  | plain text (profile name)           | when `--profile` and `SUPABASE_PROFILE` are unset (profile resolution via `legacyCliConfigLayer`)                                                 |
| `$SUPABASE_PROFILE`                    | YAML (`api_url:` / `gotrue_url:` …) | when `SUPABASE_PROFILE` is set to a file path instead of a built-in profile name                                                                  |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)            | when `SUPABASE_PROJECT_ID` is unset — supplies the submission's `project_ref`. Absent, blank, or unreadable → `null` (never fails the submission) |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path                                             | Auth                                 | Request body                                                                                                                 | Response (used fields)                                   |
| ------ | ------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST` | `<feedback-env-url>/rest/v1/interfaces_feedback` | `apikey` = committed publishable key | `{ feedback, source: "cli", user_agent, project_ref (or null), metadata: { cli_version, os, arch, is_agent, agent_name? } }` | none (fire-and-forget; only the error status is checked) |

`<feedback-env-url>` follows the resolved profile (`add.command.ts`):
`supabase-staging` / `supabase-local` → the staging feedback project;
every other profile (incl. YAML-file profiles) → production. Production
currently reuses the staging project until a dedicated one is provisioned
(CLI-1946); connection constants live in
`src/shared/feedback/feedback-submitter.layer.ts` and are safe to commit
(publishable key, insert-only RLS). The request times out after 10 s.

## Environment Variables

| Variable                | Purpose                                                                            | Required?                                                          |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                            | no (falls back to `~/.supabase/profile` → `supabase`)              |
| `SUPABASE_WORKDIR`      | project directory override                                                         | no (falls back to `--workdir` → cwd)                               |
| `SUPABASE_ACCESS_TOKEN` | access token captured by `legacyCliConfigLayer`                                    | no (unused by this command)                                        |
| `SUPABASE_PROJECT_ID`   | overrides the submission's `project_ref`, taking priority over the linked-ref file | no (falls back to `<workdir>/supabase/.temp/project-ref` → `null`) |

Agent-detection env vars (e.g. `CLAUDECODE`) are read indirectly by
`@vercel/detect-agent` via `aiToolLayer` to set the submission's
`isAgent`/`agentName` context. Global telemetry consent env applies as with
every command.

## Exit Codes

| Code | Condition                                                         |
| ---- | ----------------------------------------------------------------- |
| `0`  | success                                                           |
| `1`  | no message from args, piped stdin, or an interactive prompt       |
| `1`  | submit failure (PostgREST error, network failure, or 10s timeout) |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

The feedback message content is NEVER included in any telemetry event: the
message is a positional argument, which `extractChangedFlagNames` structurally
excludes from the `flags` property (it only scans `-`-prefixed argv tokens).
Regression-tested in `add.integration.test.ts`. The message goes only to
the `interfaces_feedback` table via the API route above.

## Output

### `--output-format text`

```
Thanks for the feedback!
```

Rendered as a clack success line after a "Sending feedback..." spinner. When
no message is passed on an interactive terminal, a "What's on your mind?"
text prompt collects it first.

### `--output-format json`

```json
{ "message": "Thanks for the feedback!" }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"message":"Thanks for the feedback!"},"timestamp":"…"}
```

## Notes

- TS-only command — no Go CLI counterpart, so no Go-parity constraints apply.
- Telemetry records `command: "feedback add"`.
- Messages starting with a dash need the `--` end-of-options sentinel:
  `supabase feedback add -- "--yes should be the default"`.
- Message resolution order: positional args → piped stdin (non-TTY) →
  interactive prompt (TTY, text mode) → error.
- Submission context: CLI version, user agent (`SupabaseCLI/<version>` from
  `LegacyCliConfig`), OS/arch, agent detection, and — when the workdir has a
  linked project — its project ref. The resolved access token is never sent.
- Project-ref resolution order: `SUPABASE_PROJECT_ID` →
  `<workdir>/supabase/.temp/project-ref` (written by `supabase link`) → `null`.
  This mirrors the soft-load half of `LegacyProjectRefResolver.resolveOptional`
  but reads the file directly, so the command has no auth dependency and works
  when the user is not logged in. Note `LegacyCliConfig.projectId` alone is only
  the env var — it is NOT linked-project-aware.
- Fire-and-forget insert (no `.select()`), matching the docs feedback widget
  and the table's insert-only RLS: the ack carries no server receipt.
