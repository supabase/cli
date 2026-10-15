# `supabase migration down`

## Files Read

| Path                                   | Format     | When                                                                                            |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/migrations/`       | directory  | always, to read migration files                                                                 |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                               |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked`, to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                                 | Purpose                                                                                                                                                                                                                                    | Required?                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN`                  | auth token for `--linked` mode                                                                                                                                                                                                             | no (falls back to keyring → `~/.supabase/access-token`)      |
| `DOTENV_PRIVATE_KEY[_*]`                 | dotenvx private key(s) to decrypt `encrypted:` `[db.vault]` secrets before upsert                                                                                                                                                          | no (required only if a `[db.vault]` value is encrypted)      |
| `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION` | deprecated alias of `SUPABASE_DB_ORIOLEDB_VERSION`, used only while that is unset; when set, stderr gets `WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.` | no                                                           |
| `SUPABASE_TARGET`                        | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml`                                                                                                                   | no (falls back to config `target`, then the command default) |

## Target selection

With no `--local`, `--linked` or `--db-url` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then `supabase/.env*`), then `target` in `supabase/config.toml` (or
`config.json`), then the local default. `remote` targets the linked project through the existing
linked path (same prompts and checks as `--linked`). An explicit selector flag always wins over the
target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid `SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config
is only read for the target when no selector flag is given; an unreadable config counts as unset.
No deprecation warning is written: the local default is unchanged.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, `supabase/.env`, `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | database connection failure                                              |
| `1`  | migration SQL execution error                                            |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

Prints `Resetting database to version: <version>` to stderr, then drops every
user schema/object (the embedded `dropObjectsSql` DO-block), upserts `[db.vault]`
secrets, and re-applies local migrations `<= version` plus seed files (each gated
on `db.migrations.enabled` / `db.seed.enabled`). Nothing is written to stdout.

### `--output-format json`

Emits `output.success("Migrations reverted", { version, last })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- Prompts `Do you want to revert the following migrations?` with the bulleted
  versions + a yellow `WARNING:` line (default **NO**). Declining exits non-zero
  (`context canceled`). `--yes` auto-confirms; a non-interactive / machine-output
  run takes the default (NO → cancel).

## Notes

- `--last` (default 1) resets up to the last n migration versions; must be `> 0`
  and `<` the number of applied migrations.
- `--local` (default true), `--linked`, and `--db-url` are mutually exclusive.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target).
- Takes no positional arguments.
- Skips a best-effort migrations-catalog cache optimization present in the old
  Go CLI (documented divergence).
- Dotenvx-encrypted (`encrypted:`) `[db.vault]` values are decrypted during config
  load using `DOTENV_PRIVATE_KEY[_*]`; an `encrypted:` value with no working key
  aborts the command with `failed to parse config: …`.
