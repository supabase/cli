## supabase-migration-repair

Repairs the migration history table.

By default, it repairs your local database. Pass `--remote` to repair the linked project, which requires running `supabase link`. Pass `--remote=<ref|branch|url>` to repair another project, a branch of the linked project, or a specific database. Repairing a hosted database asks for confirmation before it changes anything (the default answer is No); pass `--yes` to confirm in scripts and other non-interactive runs.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

If your local and remote migration history goes out of sync, you can repair the remote history by marking specific migrations as `--status applied` or `--status reverted`. Marking as `reverted` will delete an existing record from the migration history table while marking as `applied` will insert a new record.

For example, your migration history may look like the table below, with missing entries in either local or remote.

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
