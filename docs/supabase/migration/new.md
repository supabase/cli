## supabase-migration-new

Creates a new migration file locally.

A `supabase/migrations` directory will be created if it does not already exists locally. All schema migration files should be created in this directory with the pattern `<timestamp>_<name>.sql`.

Outputs from other commands like `db diff` may be piped to `migration new <name>` via stdin.
