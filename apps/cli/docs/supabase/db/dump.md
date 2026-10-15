## supabase-db-dump

Dumps contents from a remote database.

Dumps the workspace target by default, which is the local database unless `SUPABASE_TARGET` or `target` in `config.toml` says otherwise. Pass `--linked` to dump the linked project, which requires your local project to be linked by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

Runs `pg_dump` in a container with additional flags to exclude Supabase managed schemas. The ignored schemas include auth, storage, and those created by extensions.

The default dump does not contain any data or custom roles. To dump those contents explicitly, specify either the `--data-only` and `--role-only` flag.

### Note on Privilege Migration

When restoring to a new project, tables inherit ALL privileges from default privileges in the target database. To preserve specific privileges from your dump, revoke defaults before restoring:

```sql
-- Run BEFORE restoring your schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```
