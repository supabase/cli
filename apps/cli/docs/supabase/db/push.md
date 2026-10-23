## supabase-db-push

Pushes all local migrations to a database.

Pushes to the local database by default. Pass `--remote` to push to the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to push to another project, a branch of the linked project, or a database URL such as a self-hosted database. In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Before changing a hosted database, the command lists what it will do (migrations, custom roles, seed files and vault secrets) and asks once for confirmation, defaulting to No. Pass `--yes` to confirm without a prompt; JSON output, piped input and agent runs need it. A `SUPABASE_YES` set in `supabase/.env` does not confirm, but one set in your shell does.

The first time this command is run, a migration history table will be created under `supabase_migrations.schema_migrations`. After successfully applying a migration, a new row will be inserted into the migration history table with timestamp as its unique id. Subsequent pushes will skip migrations that have already been applied.

If you need to mutate the migration history table, such as deleting existing entries or inserting new entries without actually running the migration, use the `migration repair` command.

Use the `--dry-run` flag to view the list of changes before applying.
