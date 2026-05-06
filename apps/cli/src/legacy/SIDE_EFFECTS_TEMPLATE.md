# Side-effect Documentation Template

> **What is this file?**
> Every legacy command port must include a `SIDE_EFFECTS.md` in its command directory.
> It documents all observable behavior of the command: files touched, API calls made,
> environment variables consumed, and exit codes. This serves as the compatibility
> checklist for the port and as input to the E2E compatibility test suite, which diffs
> Go CLI output against TypeScript port output.
>
> **How to use this template:**
> Copy this file to `src/legacy/commands/<command>/SIDE_EFFECTS.md` (or
> `src/legacy/commands/<command>/<subcommand>/SIDE_EFFECTS.md` for subcommands).
> Fill in every section. Use `—` for "none" rather than leaving a section empty.
> See `src/legacy/commands/orgs/list/SIDE_EFFECTS.md` for a complete example.

---

# `supabase <command> [subcommand]`

<!-- Replace the heading above with the exact CLI invocation, e.g. `supabase orgs list` -->

## Files Read

<!-- List every file the command reads, in the order it reads them.
     Path notation: use ~ for $HOME, ./ for CWD-relative paths.
     Format: the file encoding / structure (plain text, JSON, TOML, …).
     When: the condition under which this file is read (e.g. "always", "when --flag is set",
     "when SUPABASE_ACCESS_TOKEN is not set"). -->

| Path                              | Format                    | When                                                       |
| --------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token`        | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| `<workdir>/.supabase/config.json` | JSON                      | always, to resolve linked project ref                      |

## Files Written

<!-- List every file the command creates or modifies.
     Use the same notation as Files Read.
     Include the file mode (permissions) if non-default. -->

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

<!-- List every Management API or other HTTP route called.
     Auth: describe the auth mechanism (e.g. "Bearer token from credentials").
     Request body: JSON shape or "none".
     Response: the fields your handler actually uses (not the full schema). -->

| Method | Path                | Auth         | Request body | Response (used fields) |
| ------ | ------------------- | ------------ | ------------ | ---------------------- |
| `GET`  | `/v1/some-resource` | Bearer token | none         | `[{id, name}]`         |

## Environment Variables

<!-- List every env var the command reads, directly or via a service.
     Required?: "yes" / "no (falls back to …)" -->

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

<!-- Cover every distinct exit path: success, expected errors, unexpected errors. -->

| Code | Condition                             |
| ---- | ------------------------------------- |
| `0`  | success                               |
| `1`  | API error (non-2xx response)          |
| `1`  | authentication error (no token found) |
| `1`  | network / connection failure          |

## Output

<!-- Describe the user-visible output for each --output-format mode.
     The E2E compatibility suite verifies text-mode output against the Go CLI exactly.
     json / stream-json output is additive (no Go CLI equivalent) but must be documented. -->

### `--output-format text` (Go CLI compatible)

<!-- Describe stdout exactly: table headers, row format, trailing newline, etc. -->

```
 ID                                    NAME
 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  My Org
```

### `--output-format json`

<!-- The argument to output.success() — a single JSON object or array emitted on stdout. -->

```json
[{ "id": "…", "name": "…" }]
```

### `--output-format stream-json`

<!-- NDJSON events. Typically: one or more `log` events during the operation,
     followed by a `result` event on success or an `error` event on failure. -->

```ndjson
{"type":"result","data":[{"id":"…","name":"…"}]}
```

## Notes

<!-- Anything else an implementer or reviewer needs to know:
     - Behaviour differences between --local / --linked / --project-ref modes
     - Idempotency characteristics
     - Known divergences from Go CLI output that are intentional
     - Side effects of retries or partial failures -->
