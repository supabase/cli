## supabase-migration-squash

Combine your local migrations into a single file. Use it to remove repeated changes to the same schema from your migration history.

The squashed migration is equivalent to a schema-only dump of the local database after applying your existing migration files. By default, the latest `<timestamp>_<name>.sql` file is updated to contain it. Choose another target with `--version <timestamp>`.

Data statements such as insert, update, or delete are omitted from the squashed migration, so you must add them back in a new migration file. This includes cron jobs, storage buckets, and any encrypted secrets in vault. If your `supabase/migrations` directory is empty, the command does nothing.

Squashing rewrites your local migration files. When the target is a hosted database (`--remote` or `--remote=<ref|branch|url>`), it also resets the remote migration history table to the squashed migration, and asks for confirmation before changing any file (the default answer is No). Pass `--yes` to confirm in scripts and other non-interactive runs.

With the default local target, the command only squashes the files and suggests running `supabase migration repair --status applied --remote` for the remote history.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.
