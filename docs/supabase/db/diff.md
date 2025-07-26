## supabase-db-diff

Diffs schema changes made to the local or remote database.

Requires the local development stack to be running when diffing against the local database. To diff against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

Runs [djrobstep/migra](https://github.com/djrobstep/migra) in a container to compare schema differences between the target database and a shadow database. The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

By default, all schemas in the target database are diffed. Use the `--schema public,extensions` flag to restrict diffing to a subset of schemas.

## Drop Statement Warnings

When DROP statements are detected in the schema diff, the command will show a warning by default. This is particularly important because column renames are often detected as DROP COLUMN + ADD COLUMN operations, which can cause data loss.

- **Default behavior**: Shows a simple warning message listing the detected DROP statements
- **With `--confirm-drops`**: Shows a detailed warning with potential risks and requires interactive confirmation before proceeding

Example usage:

```bash
# Show simple warning for DROP statements
supabase db diff

# Require confirmation for DROP statements  
supabase db diff --confirm-drops
```

While the diff command is able to capture most schema changes, there are cases where it is known to fail. Currently, this could happen if you schema contains:

- Changes to publication
- Changes to storage buckets
- Views with `security_invoker` attributes
