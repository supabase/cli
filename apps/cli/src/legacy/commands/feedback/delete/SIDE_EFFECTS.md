# `supabase feedback delete <token> [--project-ref <ref>]`

## Files Read

| Path                                            | Format                              | When                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/profile`                           | plain text (profile name)           | when `--profile` and `SUPABASE_PROFILE` are unset (profile resolution via `legacyCliConfigLayer`)                                                                                      |
| `$SUPABASE_PROFILE`                             | YAML (`api_url:` / `gotrue_url:` …) | when `SUPABASE_PROFILE` is set to a file path instead of a built-in profile name                                                                                                       |
| `<workdir>/supabase/.temp/project-ref`          | plain text (project ref)            | when `--project-ref` and `SUPABASE_PROJECT_ID` are unset — supplies the `x-feedback-project-ref` context. Absent, blank, or unreadable → header omitted (never fails the command)      |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON (telemetry state)              | read at startup by the shared telemetry runtime — its `distinct_id` (gotrue user id stamped at login) supplies the `x-feedback-user-id` context. Absent or logged-out → header omitted |

## Files Written

| Path                                            | Format | When                                                                                                                  |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | every invocation, success or failure — the shared telemetry-state finalizer (device id persistence, session rotation) |

## API Routes

| Method   | Path                                                                                     | Auth / headers                                                                                                                                                | Request body | Response (used fields)                                       |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `GET`    | `<feedback-env-url>/rest/v1/interfaces_feedback?select=feedback&delete_token=eq.<token>` | `apikey` = committed publishable key; `x-feedback-token: <token>`; `x-feedback-project-ref: <ref>` when resolved; `x-feedback-user-id: <uuid>` when logged in | —            | `[{ feedback }]` or `[]` — previews the text before deletion |
| `DELETE` | `<feedback-env-url>/rest/v1/interfaces_feedback?delete_token=eq.<token>`                 | same headers, plus `Prefer: count=exact`                                                                                                                      | —            | `Content-Range: */1` (deleted) vs `*/0` (no row matched)     |

`<feedback-env-url>` follows the resolved profile exactly as `feedback add`
does (`feedback.layers.ts` / `src/shared/feedback/feedback-client.layer.ts`).
The `delete_token=eq.` URL filter only satisfies PostgREST's filterless-delete
rejection — the `x-feedback-token` header is the security boundary enforced by
RLS. Rows submitted with a `project_ref` and/or `user_id` additionally require
the matching `x-feedback-project-ref` / `x-feedback-user-id` header on both
routes; extra context against a context-free row is ignored server-side, so
the CLI always sends whatever resolves. The user-id header is NOT gated on
telemetry consent (unlike `feedback add`'s submit-side attribution) — it is
functional auth context, and gating it would strand rows submitted before a
consent opt-out. Each request times out after 10 s. `--debug` logs each
request line on stderr with the `delete_token` filter redacted
(`delete_token=eq.redacted`) — the token is a bearer capability and must never
appear in shareable debug output.

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
| `1`  | no feedback matched (wrong token, already deleted, or project-ref/user-id context mismatch)   |
| `1`  | confirmation declined, or prompt unavailable (non-interactive / machine mode without `--yes`) |
| `1`  | backend failure (PostgREST error, network failure, or 10 s timeout) on preview or delete      |
| `1`  | `-o`/`--output` value outside the command's `pretty\|json` enum (validated pre-run)           |

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
- A row submitted while logged in (with telemetry consent) carries a `user_id`
  and can only be previewed/deleted while logged in as that same user — the
  persisted `distinct_id` is presented automatically as `x-feedback-user-id`.
  The lookup is a synchronous in-memory read; logged-out runs simply omit the
  header, which still matches all anonymous rows. `supabase logout` wipes the
  persisted identity, so a delete token for an attributed row reports "not
  found" until the user logs back in as the same account (login re-stamps the
  same gotrue UUID, restoring delete access).
