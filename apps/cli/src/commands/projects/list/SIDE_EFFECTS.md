# `supabase projects list`

## Files Read

| Path                                           | Format                    | When                                                                                                                                           |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`                     | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable                                                                                     |
| `<workdir>/supabase/.temp/project-ref`         | plain text (ref string)   | always (soft) — used only to flag the linked project                                                                                           |
| `<workdir>/supabase/.temp/linked-project.json` | JSON (`ref` field)        | only when the linked ref doesn't match any fetched project row — PARENT-chain fallback for the marker (CLI-2167 follow-up, TS-only, see Notes) |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path           | Auth         | Request body | Response (used fields)                                                             |
| ------ | -------------- | ------------ | ------------ | ---------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects` | Bearer token | none         | `[{id, organization_slug, name, region, created_at, cloud_provider, status, ...}]` |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`) |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path              | no (falls back to `~/.supabase/profile` -> `supabase`)  |

## Exit Codes

| Code | Condition                                        |
| ---- | ------------------------------------------------ |
| `0`  | success — projects printed to stdout             |
| `1`  | authentication error — no valid token found      |
| `1`  | API error — non-2xx response from `/v1/projects` |
| `1`  | network / connection failure                     |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

Two-axis: `--output {pretty|json|yaml|toml|env}` wins when set; otherwise
`--output-format`. `--output env` is **unsupported** (errors). `--output json/yaml`
encode the `linkedProject[]`; `--output toml` wraps them as `{projects=[...]}`.

### `--output-format text`

Glamour ASCII table. Column order: `LINKED`, `ORG ID`, `REFERENCE ID`, `NAME`, `REGION`,
`CREATED AT (UTC)`. The `LINKED` cell shows `  ●` for the linked project (else blank),
`REGION` is the human-readable region name, and `CREATED AT (UTC)` is `YYYY-MM-DD HH:MM:SS`.

```
  LINKED | ORG ID                | REFERENCE ID         | NAME         | REGION                  | CREATED AT (UTC)
  -------|-----------------------|----------------------|--------------|-------------------------|--------------------
    ●    | combined-fuchsia-lion | abcdefghijklmnopqrst | Test Project | East US (North Virginia)| 2022-04-25 02:14:55
```

### `--output-format json`

`success("", { projects })` — each project is the Management API object plus a
`linked` boolean.

```json
{
  "projects": [
    {
      "id": "abcdefghijklmnopqrst",
      "organization_slug": "combined-fuchsia-lion",
      "name": "Test Project",
      "region": "us-west-1",
      "created_at": "2022-04-25T02:14:55.906498Z",
      "linked": true
    }
  ]
}
```

### `--output-format stream-json`

One `result` event on success.

```ndjson
{"type":"result","data":[{"id":"abcdefghijklmnopqrst","name":"Test Project","region":"us-west-1","organization_slug":"combined-fuchsia-lion","created_at":"2022-04-25T02:14:55.906498Z"}]}
```

On failure, an `error` event is emitted instead:

```ndjson
{"type":"error","code":"ApiError","message":"…"}
```

## Notes

- No `--project-ref` flag. `projects list` is a user-level command — it lists all projects
  the authenticated user has access to.
- The result set is determined entirely by the access token's scope.
- CLI-2167 follow-up (TS-only, no Go counterpart): after `supabase link <branch>`, the linked ref
  is the BRANCH's own ref, which never matches an `id` in this endpoint's response (it only
  returns real projects), so the `LINKED` marker used to silently disappear. Fix: when the linked
  ref matches no row exactly, fall back to the PARENT chain (env `SUPABASE_PROJECT_ID` →
  `linked-project.json`'s `ref` → `project-ref` file, first ref-shaped candidate wins — same
  helper as `link`/`branches`) and mark THAT ref's row instead. An exact match always wins and
  skips the chain entirely; when nothing is linked at all, behavior is unchanged (no marker).
  **This also changes the `linked` boolean in the `-o json|yaml|toml` Go-struct payloads**: in the
  branch-linked state it was previously `false` on every row (the linked ref matched nothing) and
  can now be `true` on the parent project's row — the truthful fix IS the behavior change.
