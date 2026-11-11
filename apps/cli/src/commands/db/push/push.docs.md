Apply the local migrations that a database has not run yet. Use it to deploy schema changes to a linked project or another database.

It pushes to the local database by default. Pass `--remote` to push to the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to push to another project, a branch of the linked project, or a database URL such as a self-hosted database.

In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Before changing a hosted database, the command lists what it will do (migrations, custom roles, seed files and vault secrets) and asks once for confirmation, defaulting to No. Pass `--yes` to confirm without a prompt; JSON output, piped input and agent runs need it. A `SUPABASE_YES` set in `supabase/.env` does not confirm, but one set in your shell does.

The first run creates a migration history table at `supabase_migrations.schema_migrations`. After each migration is applied, a row with its timestamp as the unique id is added to the table, so later pushes skip migrations that were already applied.

To change the migration history table without running migrations, such as deleting entries or inserting new ones, use the `migration repair` command. Use `--dry-run` to see the list of changes before applying them.
