## supabase-migration-squash

Squashes local schema migrations to a single migration file.

Without `--local`, `--linked` or `--db-url`, the command targets the local database, unless the workspace target is set to `remote` with `target = "remote"` in `supabase/config.toml` or `SUPABASE_TARGET=remote`, in which case it targets the linked project like `--linked`. A selector flag always wins.

The squashed migration is equivalent to a schema only dump of the local database after applying existing migration files. This is especially useful when you want to remove repeated modifications of the same schema from your migration history.

However, one limitation is that data manipulation statements, such as insert, update, or delete, are omitted from the squashed migration. You will have to add them back manually in a new migration file. This includes cron jobs, storage buckets, and any encrypted secrets in vault.

By default, the latest `<timestamp>_<name>.sql` file will be updated to contain the squashed migration. You can override the target version using the `--version <timestamp>` flag.

If your `supabase/migrations` directory is empty, running `supabase squash` will do nothing.
