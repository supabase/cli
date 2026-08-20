# `supabase feedback add [message...]`

## Files Read

| Path                                            | Format                              | When                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/profile`                           | plain text (profile name)           | when `--profile` and `SUPABASE_PROFILE` are unset (profile resolution via `legacyCliConfigLayer`)                                                                                                                            |
| `$SUPABASE_PROFILE`                             | YAML (`api_url:` / `gotrue_url:` …) | when `SUPABASE_PROFILE` is set to a file path instead of a built-in profile name                                                                                                                                             |
| `<workdir>/supabase/.temp/project-ref`          | plain text (project ref)            | when `SUPABASE_PROJECT_ID` is unset — supplies the submission's `project_ref`. Absent, blank, or unreadable → `null` (never fails the submission)                                                                            |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON (telemetry state)              | read at startup by the shared telemetry runtime — its `distinct_id` (gotrue user id stamped at login) supplies the submission's `user_id` when telemetry consent is granted. Absent, logged-out, or consent-denied → omitted |

## Files Written

| Path                                            | Format | When                                                                                                                  |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | every invocation, success or failure — the shared telemetry-state finalizer (device id persistence, session rotation) |

## API Routes

| Method | Path                                                        | Auth                                 | Request body                                                                                                                                                                                    | Response (used fields)                                     |
| ------ | ----------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST` | `<feedback-env-url>/rest/v1/rpc/submit_interfaces_feedback` | `apikey` = committed publishable key | `{ feedback, user_agent, project_ref (omitted when unlinked), user_id (omitted when logged out or consent-denied), metadata: { cli_version, source: "cli", os, arch, is_agent, agent_name? } }` | uuid delete token (issued exactly once, shown to the user) |

`<feedback-env-url>` follows the resolved profile (`feedback.layers.ts`):
`supabase-staging` / `supabase-local` → the staging feedback project;
every other profile (incl. YAML-file profiles) → production. Production
currently reuses the staging project until a dedicated one is provisioned
(CLI-1946); connection constants live in
`src/shared/feedback/feedback-client.layer.ts` and are safe to commit
(publishable key; the SECURITY DEFINER RPC is the only insert path). The
request times out after 10 s.

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

| Code | Condition                                                                           |
| ---- | ----------------------------------------------------------------------------------- |
| `0`  | success                                                                             |
| `1`  | no message from args, piped stdin, or an interactive prompt                         |
| `1`  | message over the 1000-character limit (checked client-side, no request sent)        |
| `1`  | submit failure (PostgREST error, network failure, or 10s timeout)                   |
| `1`  | `-o`/`--output` value outside the command's `pretty\|json` enum (validated pre-run) |

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
To delete this feedback later, run: supabase feedback delete <delete-token>
```

Rendered as a clack success line plus an info line after a "Sending
feedback..." spinner. The delete token is shown exactly once — it is not
persisted anywhere by the CLI. When no message is passed on an interactive
terminal, a "What's on your mind?" text prompt collects it first.

### `--output-format json`

```json
{ "delete_token": "<uuid>", "message": "Thanks for the feedback!" }
```

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"delete_token":"<uuid>","message":"Thanks for the feedback!"},"timestamp":"…"}
```

## Notes

- Telemetry records `command: "feedback add"`.
- Messages starting with a dash need the `--` end-of-options sentinel:
  `supabase feedback add -- "--yes should be the default"`.
- Message resolution order: positional args → piped stdin (non-TTY) →
  interactive prompt (TTY, text mode) → error.
- Piped stdin is read in constant memory with a 64 KB cap; input past the cap
  fails as over-limit (exit 1) without buffering the rest of the pipe.
- Submission context: CLI version, user agent (`SupabaseCLI/<version>` from
  `LegacyCliConfig`), OS/arch, agent detection, and — when the workdir has a
  linked project — its project ref. The resolved access token is never sent.
- The persisted gotrue user id from `<SUPABASE_HOME or ~/.supabase>/telemetry.json` (`distinct_id`,
  stamped at login) is sent as `user_id` when present **and** telemetry consent
  is granted; opted-out or logged-out runs omit it. The lookup is a synchronous
  in-memory read — no auth or network dependency is added. A row submitted with
  a `user_id` additionally requires the matching `x-feedback-user-id` header to
  preview/delete it later (`feedback delete` sends it automatically).
- Project-ref resolution order: `SUPABASE_PROJECT_ID` →
  `<workdir>/supabase/.temp/project-ref` (written by `supabase link`) → `null`.
  This mirrors the soft-load half of `LegacyProjectRefResolver.resolveOptional`
  but reads the file directly, so the command has no auth dependency and works
  when the user is not logged in. Note `LegacyCliConfig.projectId` alone is only
  the env var — it is NOT linked-project-aware.
- Submission goes through the SECURITY DEFINER `submit_interfaces_feedback`
  RPC (the table has no insert grant), which returns a server-generated
  `delete_token` exactly once. The token is the only way to delete the
  feedback later (`supabase feedback delete <token>`), so the ack surfaces it
  in every output format; the CLI never stores it.
