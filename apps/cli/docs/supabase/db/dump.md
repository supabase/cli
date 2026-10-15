## supabase-db-dump

Dumps contents from a remote database.

Requires your local project to be linked to a remote database by running `supabase link`. For self-hosted databases, you can pass in the connection parameters using `--db-url` flag.

Without `--local`, `--linked` or `--db-url`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.

Runs `pg_dump` in a container with additional flags to exclude Supabase managed schemas. The ignored schemas include auth, storage, and those created by extensions.

The default dump does not contain any data or custom roles. To dump those contents explicitly, specify either the `--data-only` and `--role-only` flag.

### Note on Privilege Migration

When restoring to a new project, tables inherit ALL privileges from default privileges in the target database. To preserve specific privileges from your dump, revoke defaults before restoring:

```sql
-- Run BEFORE restoring your schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```
