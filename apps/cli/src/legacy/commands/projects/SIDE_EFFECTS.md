# `supabase projects` (group)

Group-level side-effect summary for the natively-ported `projects` commands:
`list`, `create`, `delete`, `api-keys`. Per-subcommand detail lives in each
subcommand's own `SIDE_EFFECTS.md`.

## Files Read

| Path                                   | Format                    | When                                                                     |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `~/.supabase/access-token`             | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable               |
| `<workdir>/supabase/.temp/project-ref` | plain text (ref string)   | `list` (linked marker), `api-keys` (ref source), `delete` (unlink match) |

## Files Written / Removed

| Path                        | Action  | When                                                             |
| --------------------------- | ------- | ---------------------------------------------------------------- |
| `<workdir>/supabase/.temp/` | removed | `delete` only — when the deleted ref matches the linked ref file |

> Go also deletes the per-ref keyring credential on `delete`. In the TS credential
> model the stored token is profile-scoped, not ref-scoped, so there is no per-ref
> entry to remove — this step is a documented no-op. The user-visible outcome
> (project gone + linked `.temp` dir removed) is preserved.

## API Routes

| Method   | Path                          | Auth         | Request body                                                                 | Response (used fields)                                                       |
| -------- | ----------------------------- | ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/v1/projects`                | Bearer token | —                                                                            | `[{id, ref, organization_slug, name, region, created_at, status, database}]` |
| `POST`   | `/v1/projects`                | Bearer token | `{name, organization_slug, db_pass, region?, desired_instance_size?}` (JSON) | `{id, ref, organization_slug, name, region, created_at, status}`             |
| `DELETE` | `/v1/projects/{ref}`          | Bearer token | —                                                                            | `{id, ref, name}`; `404` → does-not-exist                                    |
| `GET`    | `/v1/projects/{ref}/api-keys` | Bearer token | —                                                                            | `[{name, api_key?}]`                                                         |
| `GET`    | `/v1/organizations`           | Bearer token | —                                                                            | `[{id, slug, name}]` — `create` interactive org prompt only                  |

## Environment Variables

| Variable                | Purpose                                              | Required?                                                     |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring → `~/.supabase/access-token`)       |
| `SUPABASE_PROJECT_REF`  | linked project ref (via the config layer)            | no (used by `list` marker / `api-keys` ref / `delete` unlink) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)                   |

> `DB_PASSWORD` is **not** consumed. In Go it only mirrors `--db-password` via a
> viper binding for downstream local-stack use; `projects create` never reads it.

## Exit Codes

| Code | Condition                                                                      |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | success                                                                        |
| `1`  | auth / network / non-2xx status (incl. decode failure) / invalid ref           |
| `1`  | `create`: required params missing in non-interactive mode / empty project name |
| `1`  | `delete`: declined confirmation (cancellation) / no ref on a non-TTY           |
| `1`  | `list`: `--output env` is unsupported                                          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

`safeFlags` (Go `markFlagTelemetrySafe`): `--org-id` (`create`), `--project-ref`
(`api-keys`). No custom events beyond `cli_command_executed`.

## Output (two-axis: Go `--output` × TS `--output-format`)

Go's `--output {pretty|json|yaml|toml|env}` takes priority when set; otherwise the
TS `--output-format {text|json|stream-json}` applies.

- **list** — pretty/text: Glamour table `LINKED | ORG ID | REFERENCE ID | NAME | REGION | CREATED AT (UTC)`; go json/yaml/toml encode the `linkedProject[]` (`{projects=[...]}` for toml); go `env` is an error; TS json/stream-json `success("", {projects})`.
- **create** — stderr `Created a new project at <dashboard>/project/<id>` for all formats; pretty/text: table `ORG ID | REFERENCE ID | NAME | REGION | CREATED AT (UTC)`; go json/yaml/toml/env encode the created project (env supported here); TS json/stream-json `success("Created project", {...project})`.
- **delete** — text: confirmation prompt (default No, honours `--yes`) then stdout `Deleted project: <name>`; TS json/stream-json `success("Deleted project", {name})`.
- **api-keys** — pretty/text: Glamour table `NAME | KEY VALUE` (`******` masks null keys); go toml/env encode the `SUPABASE_<NAME>_KEY` map; go json/yaml encode `ApiKeyResponse[]`; TS json/stream-json `success("", {keys})`.

## Notes

- **Terminal color:** Go wraps refs / project names / dashboard URLs in ANSI
  (`utils.Aqua`, `utils.Bold`); the TS port emits plain text. Go's lipgloss
  renderer disables color when stdout/stderr is not a TTY, so piped / CI output
  matches byte-for-byte; only the interactive-terminal appearance differs.
- **`create` linked cache:** the new project ref is cached on success;
  `delete` also caches the resolved ref (Go's `PersistentPostRun` parity), even
  though the project is gone — the cache is a telemetry-group record, separate
  from the `supabase/.temp` link removed during unlink.
- **`create` non-interactive errors:** TS consolidates cobra's per-flag
  "required flag(s) … not set" errors into a single `LegacyProjectsCreateMissingArgError`
  that lists every missing item at once (a deliberate UX improvement over Go's
  fail-on-first behavior).
- `--plan` on `create` is accepted but ignored (no-op, hidden) — vestigial in Go too.
- `create` interactivity is gated on `--interactive` (default true) **and** a TTY stdin
  **and** an interactive (text-mode) `Output`.
- `delete` confirmation defaults to **No** and honours the global `--yes`.
- `api-keys` resolves `--project-ref` via the shared resolver (flag → env →
  `.temp/project-ref` → prompt on a TTY → error when unlinked), matching Go's root
  `ParseProjectRef`.
