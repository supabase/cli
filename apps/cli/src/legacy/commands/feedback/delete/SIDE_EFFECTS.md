# `supabase feedback delete <token> [--project-ref <ref>]`

## Files Read

| Path                                   | Format                              | When                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/profile`                  | plain text (profile name)           | when `--profile` and `SUPABASE_PROFILE` are unset (profile resolution via `legacyCliConfigLayer`)                                                                                 |
| `$SUPABASE_PROFILE`                    | YAML (`api_url:` / `gotrue_url:` …) | when `SUPABASE_PROFILE` is set to a file path instead of a built-in profile name                                                                                                  |
| `<workdir>/supabase/.temp/project-ref` | plain text (project ref)            | when `--project-ref` and `SUPABASE_PROJECT_ID` are unset — supplies the `x-feedback-project-ref` context. Absent, blank, or unreadable → header omitted (never fails the command) |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method   | Path                                                                                     | Auth / headers                                                                                                   | Request body | Response (used fields)                                       |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `GET`    | `<feedback-env-url>/rest/v1/interfaces_feedback?select=feedback&delete_token=eq.<token>` | `apikey` = committed publishable key; `x-feedback-token: <token>`; `x-feedback-project-ref: <ref>` when resolved | —            | `[{ feedback }]` or `[]` — previews the text before deletion |
| `DELETE` | `<feedback-env-url>/rest/v1/interfaces_feedback?delete_token=eq.<token>`                 | same headers, plus `Prefer: count=exact`                                                                         | —            | `Content-Range: */1` (deleted) vs `*/0` (no row matched)     |

`<feedback-env-url>` follows the resolved profile exactly as `feedback add`
does (`feedback.layers.ts` / `src/shared/feedback/feedback-client.layer.ts`).
The `delete_token=eq.` URL filter only satisfies PostgREST's filterless-delete
rejection — the `x-feedback-token` header is the security boundary enforced by
RLS. Rows submitted with a `project_ref` additionally require the matching
`x-feedback-project-ref` header on both routes; sending it against a
context-free row is ignored server-side, so the CLI always sends whatever ref
resolves. Each request times out after 10 s.

## Environment Variables

| Variable                | Purpose                                                        | Required?                                                           |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                        | no (falls back to `~/.supabase/profile` → `supabase`)               |
| `SUPABASE_WORKDIR`      | project directory override                                     | no (falls back to `--workdir` → cwd)                                |
| `SUPABASE_ACCESS_TOKEN` | access token captured by `legacyCliConfigLayer`                | no (unused by this command)                                         |
| `SUPABASE_PROJECT_ID`   | supplies the project-ref context when `--project-ref` is unset | no (falls back to `<workdir>/supabase/.temp/project-ref` → omitted) |
| `SUPABASE_YES`          | auto-confirms the deletion prompt, same as `--yes`             | no                                                                  |

Global telemetry consent env applies as with every command.

## Exit Codes

| Code | Condition                                                                                     |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | feedback deleted                                                                              |
| `1`  | token argument is not a UUID                                                                  |
| `1`  | no feedback matched (wrong token, already deleted, or project-ref context mismatch)           |
| `1`  | confirmation declined, or prompt unavailable (non-interactive / machine mode without `--yes`) |
| `1`  | backend failure (PostgREST error, network failure, or 10 s timeout) on preview or delete      |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

The delete token is NEVER included in any telemetry event: it is a positional
argument, which `extractChangedFlagNames` structurally excludes from the
`flags` property (it only scans `-`-prefixed argv tokens). `--project-ref` is
recorded by name only; its value is redacted (no telemetry-safe marking).
Regression-tested in `delete.integration.test.ts`.

## Output

### `--output-format text`

```
Found feedback: "<feedback text>"
Permanently delete this feedback? [y/N]
Feedback deleted.
```

The preview renders as an info line after a "Looking up feedback..." spinner;
the delete runs behind a "Deleting feedback..." spinner. `--yes` /
`SUPABASE_YES` skips the confirmation prompt.

### `--output-format json`

```json
{ "feedback": "<feedback text>", "message": "Feedback deleted." }
```

Requires `--yes`: machine modes cannot prompt, and the command fails loudly
rather than deleting without confirmation.

### `--output-format stream-json`

```ndjson
{"type":"result","data":{"feedback":"<feedback text>","message":"Feedback deleted."},"timestamp":"…"}
```

Also requires `--yes`.

## Notes

- TS-only command — no Go CLI counterpart, so no Go-parity constraints apply.
- Telemetry records `command: "feedback delete"`.
- The token is validated client-side against the UUID shape before any request
  (avoids PostgREST's cryptic uuid-cast error) and lowercased for the backend.
- The feedback text is previewed before deletion so the user can verify what
  the token unlocks; machine modes return the deleted text in the result
  payload instead.
- Deletion is a hard delete with no undo; tokens never expire.
- Project-ref resolution order: `--project-ref` → `SUPABASE_PROJECT_ID` →
  `<workdir>/supabase/.temp/project-ref` (written by `supabase link`) →
  omitted. A row submitted from a linked project can only be previewed/deleted
  with that same ref presented — rerun from the linked directory or pass
  `--project-ref`. This mirrors `feedback add`'s resolution and works
  logged-out (no auth dependency).
