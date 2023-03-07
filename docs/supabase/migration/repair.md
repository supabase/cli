## supabase-migration-repair

Repairs the remote migration history table.

If your local and remote migration history goes out of sync, you can repair the remote history by marking specific migrations as `--status applied` or `--status reverted`. Marking as `reverted` will delete an existing record from the migration history table while marking as `applied` will insert a new record.

For example, your migration history table may look like this after running `db remote commit` for the first time.

```bash
$ supabase migration list
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
    20230103054303 │ 20230103054303 │ 2023-01-03 05:43:03
```

To reset your migration history to a clean state, first delete your local migration file.

```bash
$ rm supabase/migrations/20230103054303_remote_commit.sql
$ supabase migration list
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
                   │ 20230103054303 │ 2023-01-03 05:43:03
```

Then mark the remote migration `20230103054303` as reverted.

```bash
$ supabase migration repair 20230103054303 --status reverted
Repaired migration history: 20230103054303 => reverted
$ supabase migration list
        LOCAL      │     REMOTE     │     TIME (UTC)
  ─────────────────┼────────────────┼──────────────────────
```

Now you can run `db remote commit` again to dump the remote schema as a local migration file.
