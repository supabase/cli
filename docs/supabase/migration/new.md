## supabase-migration-new

Creates a new migration file locally.

A `supabase/migrations` directory will be created if it does not already exists in your current `workdir`. All schema migration files must be created in this directory following the pattern `<timestamp>_<name>.sql`.

Outputs from other commands like `db diff` may be piped to `migration new <name>` via stdin.
