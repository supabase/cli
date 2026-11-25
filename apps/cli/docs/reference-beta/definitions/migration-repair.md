---
id: migration-repair
kind: command
category: Migrations
title: migration repair
symbol: supabase migration repair
summary: Repair the migration history
usage: supabase migration repair [version] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: version
    location: positional
    required: false
    variadic: true
  - name: --password
    location: flag
    type: string
    description: Database password for the project selected with --remote; ignored for the local database and database URLs.
    short: -p
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
  - name: --status
    location: flag
    type: "[ applied | reverted ]"
    required: true
    description: Status to record for the given migration versions.
    allowed_values:
      - applied
      - reverted
examples:
  - id: basic-usage
    title: Mark a migration as reverted
    lang: sh
    code: supabase migration repair 20230103054303 --status reverted --yes --remote
    response: |
      Target: project My Project (abcdefghijklmnopqrst) · production
      Confirmed by --yes: Mark 1 migration as reverted on project My Project (abcdefghijklmnopqrst) · production
      Repaired migration history: [20230103054303] => reverted
  - id: mark-applied
    title: Mark a migration as applied
    lang: sh
    code: supabase migration repair 20230222032233 --status applied --yes --remote
    response: |
      Target: project My Project (abcdefghijklmnopqrst) · production
      Confirmed by --yes: Mark 1 migration as applied on project My Project (abcdefghijklmnopqrst) · production
      Repaired migration history: [20230222032233] => applied
---

Mark migrations as applied or reverted in the migration history table, without running them. Use it when the local files and the history of a database are out of sync.

It repairs the local database by default. Pass `--remote` to repair the linked project, which requires running `supabase link`. Pass `--remote=<ref|branch|url>` to repair another project, a branch of the linked project, or a specific database.

Repairing a hosted database asks for confirmation before it changes anything (the default answer is No). Pass `--yes` to confirm in scripts and other non-interactive runs.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Marking a migration as `reverted` deletes its record from the migration history table, and marking it as `applied` inserts a new record.

## Example

Your migration history may look like the table below, with entries missing on either the local or the remote side.

```bash
$ supabase migration list --remote
Target: project My Project (abcdefghijklmnopqrst) · production
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
                   │ 20230103054303 │ 2023-01-03 05:43:03
   20230103054315  │                │ 2023-01-03 05:43:15
```

To reset your migration history to a clean state, first delete your local migration file.

```bash
$ rm supabase/migrations/20230103054315_remote_commit.sql

$ supabase migration list --remote
Target: project My Project (abcdefghijklmnopqrst) · production
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
                   │ 20230103054303 │ 2023-01-03 05:43:03
```

Then mark the remote migration `20230103054303` as reverted.

```bash
$ supabase migration repair 20230103054303 --status reverted --remote
Target: project My Project (abcdefghijklmnopqrst) · production
 • 20230103054303
◇  Mark 1 migration as reverted on project My Project (abcdefghijklmnopqrst) · production?
│  Yes
Repaired migration history: [20230103054303] => reverted
Finished supabase migration repair.

$ supabase migration list --remote
Target: project My Project (abcdefghijklmnopqrst) · production
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
```

Now you can run `db pull` again to dump the remote schema as a local migration file.

```bash
$ supabase db pull --remote
Target: project My Project (abcdefghijklmnopqrst) · production
Write 1 migration file to supabase/migrations.
Record them as applied in the remote migration history.
◇  Update the remote migration history table on project My Project (abcdefghijklmnopqrst) · production?
│  Yes
Schema written to supabase/migrations/20240414044403_remote_schema.sql
Finished supabase db pull.

$ supabase migration list --remote
Target: project My Project (abcdefghijklmnopqrst) · production
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
    20240414044403 │ 20240414044403 │ 2024-04-14 04:44:03
```
