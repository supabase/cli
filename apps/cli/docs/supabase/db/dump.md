## supabase-db-dump

Export the schema of a database as a SQL script, or its data or custom roles with `--data-only` and `--role-only`. Use it to back up a database or to copy it to another project.

It dumps the local database by default. Pass `--remote` to dump the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to dump another project, a branch of the linked project, or a database URL such as a self-hosted database.

The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

The command runs `pg_dump` in a container and excludes Supabase-managed schemas, including `auth`, `storage`, and those created by extensions. The default dump contains neither data nor custom roles.

### Note on privilege migration

When you restore to a new project, tables inherit ALL privileges from the default privileges in the target database. To keep specific privileges from your dump, revoke the defaults before restoring:

```sql
-- Run BEFORE restoring your schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
```
