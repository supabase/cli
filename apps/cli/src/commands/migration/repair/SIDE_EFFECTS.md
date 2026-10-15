# `supabase migration repair`

## Files Read

| Path                                   | Format     | When                                                                                                      |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `~/.supabase/access-token`             | plain text | when `SUPABASE_ACCESS_TOKEN` unset and `--linked`                                                         |
| `<workdir>/supabase/.temp/project-ref` | plain text | `--linked` (default), to resolve the ref — skipped when `--project-ref` (or `SUPABASE_PROJECT_ID`) is set |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable                | Purpose                                                                                                                  | Required?                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | auth token for `--linked` mode                                                                                           | no (falls back to keyring → `~/.supabase/access-token`)      |
| `DB_PASSWORD`           | password for direct database connection                                                                                  | no                                                           |
| `SUPABASE_TARGET`       | workspace target (`local` or `remote`) used when no selector flag is given; overrides `target` in `supabase/config.toml` | no (falls back to config `target`, then the command default) |

## Target selection

With no `--local`, `--linked` or `--db-url` flag, the command follows the workspace target: `SUPABASE_TARGET` (`local` or `remote`;
shell environment first, then the project `.env*` files), then `target` in `supabase/config.toml` (or
`config.json`). `remote` targets the linked project through the existing linked path; `local`
targets the local database. An explicit selector flag always wins over the target. `--project-ref` is not a selector: a `remote` target resolves it to the linked project, while with no target or
`target = "local"` it behaves exactly as it did before the target existed. An invalid
`SUPABASE_TARGET` or `target` value exits `1` with `WorkspaceTargetError`. Config is only read for
the target when no selector flag is given; an unreadable config counts as unset.

When the target resolves to the linked project, the command writes one line to **stderr** naming where the
setting came from, so a config-driven target is never silent:

```
Targeting the linked project (target = "remote" from <source>)
```

`<source>` is `SUPABASE_TARGET`, the `.env*` file that set it (for example `supabase/.env.local` or `.env`), `supabase/config.toml` or `supabase/config.json`.
Nothing is written when a selector flag decides the target.

When neither is set the command keeps targeting the linked project and writes one warning to
**stderr** (every `--output-format`, never stdout), so scripts depending on today's default keep
working while the next major version moves it to the local database:

```
Warning: supabase migration repair will target the local database by default in the next major version. Pass --linked to keep targeting the linked project. Setting target = "remote" in your Supabase config (or SUPABASE_TARGET=remote) also works, but applies to every database command that can run locally, including db reset.
```

No warning is written when a selector flag, `--project-ref`, `SUPABASE_TARGET` or `target` is set.

With a `local` workspace target and no selector flag, `--password` fails with the command's password-flag error
instead of being silently dropped; pass `--linked` or set `target = "remote"`.

## Exit Codes

| Code | Condition                                                                |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | database connection failure                                              |
| `1`  | invalid or missing `--status` flag                                       |
| `1`  | `--project-ref` set with a resolved target other than linked (see Notes) |

## Output

### `--output-format text`

When repairing specific versions, prints `Repaired migration history: [<versions>]
=> <status>` to stderr, then `Finished supabase migration repair.` to stdout and
the suggestion `Run supabase migration list to show the updated migration history.`
to stderr. The DB work is the history-table provisioning (its own transaction,
skipped entirely when a read-only probe finds the ledger already provisioned, so a
provisioned remote runs no provisioning DDL — supabase/cli#6393) followed by one
repair transaction: (for repair-all) `TRUNCATE`, plus `applied` → per-version
`UPSERT` from the local file, `reverted` → `DELETE ... WHERE version = ANY($1)`.

> **Atomicity note:** the old Go CLI ran the TRUNCATE/UPSERT/DELETE via a batched
> pipeline (not an explicit transaction), so a partial failure mid-batch (e.g.
> TRUNCATE commits but a later UPSERT fails) could leave the history table in a
> half-updated state. The TS port wraps the same statements in an explicit
> `BEGIN`/`COMMIT` with `ROLLBACK` on error, so a partial failure leaves the table
> unchanged. This handler deliberately keeps that safer transaction instead of using
> the migration apply path's batch primitive; the success path is unchanged.

### `--output-format json`

Emits `output.success("Migration history repaired", { versions, status, repairAll })`.

### `--output-format stream-json`

Same structured result delivered as an NDJSON `result` event.

## Prompts

- With no version arguments (repair-all), prompts `Do you want to repair the entire
migration history table to match local migration files?` (default **NO**).
  Declining exits non-zero (`context canceled`). `--yes` auto-confirms; a
  non-interactive / machine-output run takes the default (NO → cancel).

## Notes

- `--status` flag is required and accepts `applied` or `reverted`.
- Accepts zero or more migration version arguments; each must be numeric
  (`failed to parse <v>: invalid version number` otherwise). Zero versions enables
  repair-all.
- In `applied` mode, reads the matching `supabase/migrations/<version>_*.sql` file
  for the name + statements; a missing file exits non-zero.
- `--linked` (default true), `--local`, and `--db-url` are mutually exclusive, as
  are `--db-url` and `--password`/`-p`.
- **`--project-ref`** (TS-only, no Go equivalent on any user-facing command)
  overrides ONLY the linked-ref resolution used for the connection (flag >
  `SUPABASE_PROJECT_ID` > `.temp/project-ref`). It never implies `--linked`:
  passing it with a resolved `--local`/`--db-url` target is a hard error rather
  than a silently discarded flag (deliberately stricter than
  `SUPABASE_PROJECT_ID`, which Go's equivalent env var simply leaves unused on
  a non-linked target).
