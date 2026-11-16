## supabase-db-dump

Dumps contents from a database.

Dumps the local database by default. Pass `--remote` to dump the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to dump another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Runs `pg_dump` in a container with additional flags to exclude Supabase managed schemas. The ignored schemas include auth, storage, and those created by extensions.

The default dump does not contain any data or custom roles. To dump those contents explicitly, specify either the `--data-only` and `--role-only` flag.

### Note on Privilege Migration

When restoring to a new project, tables inherit ALL privileges from default privileges in the target database. To preserve specific privileges from your dump, revoke defaults before restoring:

```sql
-- Run BEFORE restoring your schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```
